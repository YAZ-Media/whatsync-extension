-- Provider-backed billing is separate from legacy, unverified subscriptions/invoices.
-- Do NOT migrate old "paid" records into this table without provider reconciliation.
create table if not exists public.billing_customers (
  account_id uuid primary key,
  stripe_customer_id text not null unique,
  billing_email text,
  created_at timestamptz not null default now()
);
create table if not exists public.billing_subscriptions (
  stripe_subscription_id text primary key,
  account_id uuid not null references public.billing_customers(account_id),
  plan_name text not null check (plan_name in ('Starter','Team','Business')),
  status text not null,
  currency text not null,
  unit_amount integer,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  livemode boolean not null default false,
  last_event_created bigint not null,
  updated_at timestamptz not null default now()
);
create index if not exists billing_subscriptions_account on public.billing_subscriptions(account_id, updated_at desc);
create table if not exists public.billing_webhook_events (
  event_id text primary key,
  event_created bigint not null,
  processed_at timestamptz not null default now()
);
alter table public.billing_customers enable row level security;
alter table public.billing_subscriptions enable row level security;
alter table public.billing_webhook_events enable row level security;
revoke all on public.billing_customers, public.billing_subscriptions, public.billing_webhook_events from anon, authenticated;
grant all on public.billing_customers, public.billing_subscriptions, public.billing_webhook_events to service_role;

create or replace function public.apply_billing_event(p_event_id text, p_created bigint, p_snapshot jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  -- Serialize all updates for this subscription; replay and snapshot commit together.
  perform pg_advisory_xact_lock(hashtextextended(p_snapshot->>'stripe_subscription_id',0));
  if exists(select 1 from billing_webhook_events where event_id = p_event_id) then return; end if;
  insert into billing_subscriptions(stripe_subscription_id,account_id,plan_name,status,currency,unit_amount,current_period_end,cancel_at_period_end,livemode,last_event_created)
  values(p_snapshot->>'stripe_subscription_id',(p_snapshot->>'account_id')::uuid,p_snapshot->>'plan_name',p_snapshot->>'status',p_snapshot->>'currency',(p_snapshot->>'unit_amount')::integer,(p_snapshot->>'current_period_end')::timestamptz,(p_snapshot->>'cancel_at_period_end')::boolean,(p_snapshot->>'livemode')::boolean,p_created)
  on conflict (stripe_subscription_id) do update set
    plan_name=excluded.plan_name,status=excluded.status,currency=excluded.currency,unit_amount=excluded.unit_amount,current_period_end=excluded.current_period_end,cancel_at_period_end=excluded.cancel_at_period_end,livemode=excluded.livemode,last_event_created=excluded.last_event_created,updated_at=now()
  where billing_subscriptions.last_event_created <= excluded.last_event_created;
  insert into billing_webhook_events(event_id,event_created) values(p_event_id,p_created);
end;
$$;
revoke all on function public.apply_billing_event(text,bigint,jsonb) from public, anon, authenticated;
grant execute on function public.apply_billing_event(text,bigint,jsonb) to service_role;
