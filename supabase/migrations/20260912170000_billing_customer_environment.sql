-- Preserve independent Stripe customer identities for live billing and the
-- explicitly allowlisted acceptance-test environment.
alter table public.billing_subscriptions
  drop constraint if exists billing_subscriptions_account_id_fkey;

alter table public.billing_checkout_attempts
  drop constraint if exists billing_checkout_attempts_account_id_fkey;

alter table public.billing_customers
  drop constraint if exists billing_customers_pkey;

alter table public.billing_customers
  add constraint billing_customers_pkey primary key (account_id, livemode);
