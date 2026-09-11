-- One unfinished hosted checkout per workspace, including concurrent requests.
-- A rolling timestamp key alone can create two subscriptions at its boundary.
create table public.billing_checkout_attempts (
  account_id uuid primary key references public.billing_customers(account_id),
  attempt_id uuid not null default gen_random_uuid(),
  plan_name text not null check(plan_name in ('Starter','Team','Business')),
  expires_at bigint not null
);
alter table public.billing_checkout_attempts enable row level security;
revoke all on public.billing_checkout_attempts from anon, authenticated;
grant all on public.billing_checkout_attempts to service_role;

create function public.reserve_billing_checkout(p_account_id uuid, p_plan_name text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare attempt public.billing_checkout_attempts;
begin
  perform pg_advisory_xact_lock(hashtextextended('checkout:' || p_account_id::text,0));
  select * into attempt from billing_checkout_attempts where account_id=p_account_id;
  if attempt.account_id is null or attempt.expires_at <= extract(epoch from clock_timestamp()) then
    insert into billing_checkout_attempts(account_id,plan_name,expires_at)
    values(p_account_id,p_plan_name,floor(extract(epoch from clock_timestamp()))::bigint+3600)
    on conflict(account_id) do update set attempt_id=gen_random_uuid(),plan_name=excluded.plan_name,expires_at=excluded.expires_at
    returning * into attempt;
  end if;
  return to_jsonb(attempt);
end;
$$;
revoke all on function public.reserve_billing_checkout(uuid,text) from public,anon,authenticated;
grant execute on function public.reserve_billing_checkout(uuid,text) to service_role;
