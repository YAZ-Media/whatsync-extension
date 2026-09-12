-- Align verified billing with the approved WhatSync Pro per-seat offer.
-- Legacy plan names remain valid only for historical rows; new checkout exposes Pro Monthly/Annual.
alter table public.billing_subscriptions
  add column if not exists quantity integer not null default 1,
  add column if not exists billing_interval text;

alter table public.billing_subscriptions
  drop constraint if exists billing_subscriptions_plan_name_check;
alter table public.billing_subscriptions
  add constraint billing_subscriptions_plan_name_check
  check (plan_name in ('Starter','Team','Business','Pro Monthly','Pro Annual'));
alter table public.billing_subscriptions
  add constraint billing_subscriptions_quantity_check check (quantity between 1 and 250);
alter table public.billing_subscriptions
  add constraint billing_subscriptions_interval_check check (billing_interval is null or billing_interval in ('month','year'));

alter table public.billing_checkout_attempts
  add column if not exists seats integer not null default 1;
alter table public.billing_checkout_attempts
  drop constraint if exists billing_checkout_attempts_plan_name_check;
alter table public.billing_checkout_attempts
  add constraint billing_checkout_attempts_plan_name_check
  check (plan_name in ('Starter','Team','Business','Pro Monthly','Pro Annual'));
alter table public.billing_checkout_attempts
  add constraint billing_checkout_attempts_seats_check check (seats between 1 and 250);

drop function if exists public.reserve_billing_checkout(uuid,text);
create or replace function public.reserve_billing_checkout(p_account_id uuid, p_plan_name text, p_seats integer)
returns jsonb language plpgsql security definer set search_path=public as $$
declare attempt public.billing_checkout_attempts;
begin
  if p_seats < 1 or p_seats > 250 then raise exception 'Invalid seat count'; end if;
  perform pg_advisory_xact_lock(hashtextextended('checkout:' || p_account_id::text,0));
  select * into attempt from billing_checkout_attempts where account_id=p_account_id;
  if attempt.account_id is null or attempt.expires_at <= extract(epoch from clock_timestamp()) then
    insert into billing_checkout_attempts(account_id,plan_name,seats,expires_at)
    values(p_account_id,p_plan_name,p_seats,floor(extract(epoch from clock_timestamp()))::bigint+3600)
    on conflict(account_id) do update set
      attempt_id=gen_random_uuid(),plan_name=excluded.plan_name,seats=excluded.seats,expires_at=excluded.expires_at
    returning * into attempt;
  end if;
  return to_jsonb(attempt);
end;
$$;
revoke all on function public.reserve_billing_checkout(uuid,text,integer) from public,anon,authenticated;
grant execute on function public.reserve_billing_checkout(uuid,text,integer) to service_role;

create or replace function public.apply_billing_event(p_event_id text, p_created bigint, p_snapshot jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(p_snapshot->>'stripe_subscription_id',0));
  if exists(select 1 from billing_webhook_events where event_id = p_event_id) then return; end if;
  insert into billing_subscriptions(
    stripe_subscription_id,account_id,plan_name,status,currency,unit_amount,quantity,billing_interval,
    current_period_end,cancel_at_period_end,livemode,last_event_created
  )
  values(
    p_snapshot->>'stripe_subscription_id',(p_snapshot->>'account_id')::uuid,p_snapshot->>'plan_name',
    p_snapshot->>'status',p_snapshot->>'currency',(p_snapshot->>'unit_amount')::integer,
    coalesce((p_snapshot->>'quantity')::integer,1),p_snapshot->>'billing_interval',
    (p_snapshot->>'current_period_end')::timestamptz,(p_snapshot->>'cancel_at_period_end')::boolean,
    (p_snapshot->>'livemode')::boolean,p_created
  )
  on conflict (stripe_subscription_id) do update set
    plan_name=excluded.plan_name,status=excluded.status,currency=excluded.currency,
    unit_amount=excluded.unit_amount,quantity=excluded.quantity,billing_interval=excluded.billing_interval,
    current_period_end=excluded.current_period_end,cancel_at_period_end=excluded.cancel_at_period_end,
    livemode=excluded.livemode,last_event_created=excluded.last_event_created,updated_at=now()
  where billing_subscriptions.last_event_created <= excluded.last_event_created;
  insert into billing_webhook_events(event_id,event_created) values(p_event_id,p_created);
end;
$$;
revoke all on function public.apply_billing_event(text,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.apply_billing_event(text,bigint,jsonb) to service_role;

