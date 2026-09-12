-- Keep live and acceptance-test Stripe customer identities distinct.
-- A test customer can replace the mapping only for the explicitly allowlisted
-- acceptance workspace; switching back to live creates a fresh live mapping.
alter table public.billing_customers
  add column if not exists livemode boolean not null default true;
