\set ON_ERROR_STOP on
-- Run only against a disposable local test database. Never against production.
begin;
create role anon;
create role authenticated;
create role service_role;
\ir ../migrations/20260911000000_verified_billing.sql
\ir ../migrations/20260911221500_checkout_attempts.sql
insert into public.billing_customers(account_id,stripe_customer_id) values('11111111-1111-1111-1111-111111111111','cus_fixture');
select public.apply_billing_event('evt_new',200,'{"stripe_subscription_id":"sub_fixture","account_id":"11111111-1111-1111-1111-111111111111","plan_name":"Starter","status":"active","currency":"usd","unit_amount":2900,"current_period_end":"2030-01-01","cancel_at_period_end":false,"livemode":false}');
select public.apply_billing_event('evt_new',200,'{"stripe_subscription_id":"sub_fixture"}');
select public.apply_billing_event('evt_old',100,'{"stripe_subscription_id":"sub_fixture","account_id":"11111111-1111-1111-1111-111111111111","plan_name":"Starter","status":"canceled","currency":"usd","unit_amount":2900,"current_period_end":"2030-01-01","cancel_at_period_end":false,"livemode":false}');
do $$begin
 if (select count(*) from billing_subscriptions) <> 1 then raise exception 'Replay created duplicate subscription'; end if;
 if (select status from billing_subscriptions limit 1) <> 'active' then raise exception 'Stale event regressed status'; end if;
 if (select count(*) from billing_webhook_events) <> 2 then raise exception 'Replay created duplicate event'; end if;
 begin
  perform public.apply_billing_event('evt_invalid',300,'{"stripe_subscription_id":"sub_bad","account_id":"11111111-1111-1111-1111-111111111111","plan_name":"INVALID","status":"active","currency":"usd","unit_amount":2900,"cancel_at_period_end":false,"livemode":false}');
  raise exception 'Expected validation failure';
 exception when check_violation then null; end;
 if exists(select 1 from billing_webhook_events where event_id='evt_invalid') then raise exception 'Failed snapshot consumed event'; end if;
 if has_table_privilege('anon','billing_subscriptions','SELECT') or has_table_privilege('authenticated','billing_subscriptions','SELECT') then raise exception 'Client roles can read global billing data'; end if;
 if has_function_privilege('authenticated','public.apply_billing_event(text,bigint,jsonb)','EXECUTE') then raise exception 'Client can forge verified events'; end if;
 if not has_table_privilege('service_role','billing_subscriptions','SELECT') then raise exception 'Service cannot access billing'; end if;
 if exists(select 1 from pg_class where relname in ('billing_customers','billing_subscriptions','billing_webhook_events') and not relrowsecurity) then raise exception 'RLS not enabled'; end if;
end$$;
do $$
declare first_attempt jsonb; retry_attempt jsonb; changed_attempt jsonb;
begin
 first_attempt := reserve_billing_checkout('11111111-1111-1111-1111-111111111111','Starter');
 retry_attempt := reserve_billing_checkout('11111111-1111-1111-1111-111111111111','Starter');
 if first_attempt <> retry_attempt then raise exception 'Retry replaced active checkout'; end if;
 changed_attempt := reserve_billing_checkout('11111111-1111-1111-1111-111111111111','Team');
 if first_attempt <> changed_attempt then raise exception 'Another plan replaced active checkout'; end if;
 update billing_checkout_attempts set expires_at=0;
 retry_attempt := reserve_billing_checkout('11111111-1111-1111-1111-111111111111','Team');
 if first_attempt->>'attempt_id' = retry_attempt->>'attempt_id' or retry_attempt->>'plan_name' <> 'Team' then raise exception 'Expired checkout was not renewed'; end if;
 if has_function_privilege('authenticated','reserve_billing_checkout(uuid,text)','EXECUTE') or has_table_privilege('authenticated','billing_checkout_attempts','UPDATE') then raise exception 'Client can replace checkout reservation'; end if;
end $$;
rollback;
\echo 'PASS: migration, replay, ordering, atomic failure, checkout reservation/expiry, grants and RLS flags'
