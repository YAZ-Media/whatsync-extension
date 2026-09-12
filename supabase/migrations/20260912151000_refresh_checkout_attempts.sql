-- Stripe requires at least 30 minutes remaining when a Checkout Session is created.
-- Renew a reservation before it enters that window so retries never dead-end.
create or replace function public.reserve_billing_checkout(p_account_id uuid, p_plan_name text, p_seats integer)
returns jsonb language plpgsql security definer set search_path=public as $$
declare attempt public.billing_checkout_attempts;
begin
  if p_seats < 1 or p_seats > 250 then raise exception 'Invalid seat count'; end if;
  perform pg_advisory_xact_lock(hashtextextended('checkout:' || p_account_id::text,0));
  select * into attempt from billing_checkout_attempts where account_id=p_account_id;
  if attempt.account_id is null or attempt.expires_at <= floor(extract(epoch from clock_timestamp()))::bigint + 1800 then
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
