# Owner access and Stripe readiness — September 12, 2026

## Verified

- Stripe browser session belongs to YAZ MARKETING LLC. No real payment has been attempted.
- The WhatSync production backend has the live Stripe API key and matching live webhook signing secret stored as encrypted Edge Function secrets. Neither credential is present in source code or release artifacts.
- A live webhook destination is active at `https://ogsvchujqpayuckxuwdf.supabase.co/functions/v1/billing` for the six required subscription, checkout and invoice events.
- The approved live catalog is USD 19 per syncing user monthly and USD 180 per syncing user annually. Checkout accepts 1–250 seats, enforces active syncing users, records accepted subscription terms and stores Stripe-verified quantity and interval from webhooks.
- The live customer portal supports billing details, payment methods, invoices and cancellation at period end. WhatSync also supports prorated paid-seat changes with pending-payment protection.
- The configured owner allowlist matches yazan@yazmedia.com, user UUID 26ca8f7d-528b-4155-a840-db9d09d5aac2. The profile is Active with Owner role.
- Internal owner access is explicit and restricted to that server allowlist. It enables the owner's own CRM operations without manufacturing a paid subscription. Suspended owner accounts are still blocked.
- Customer workspace Owner roles do not confer platform ownership or customer-wide visibility.

## Internal console

`/dashboard/subscribers` is now labelled Owner console. It provides registered and active user counts, connected HubSpot users, current live subscriptions, paginated email search across accounts, roles/status, portal connection status, reported extension version and last activity, recent error metadata, and processed billing events. It also checks Stripe account identity, prices, webhook registration, portal configuration and live-mode readiness. Missing configuration is shown explicitly.

It does not expose API keys, OAuth tokens, chat bodies or raw error messages. Account suspension, refunds and customer impersonation are not implemented in this console. Use the merchant dashboard for financial operations; do not describe the console as supporting actions it does not yet offer.

## Connection status

The Supabase and Stripe sessions are connected. The live Stripe API key, account ID, prices and webhook signing secret are configured against the correct WhatSync backend (`ogsvchujqpayuckxuwdf`). Public sales remain deliberately closed.

No live WhatSync checkout, renewal, failure recovery, cancellation or refund has yet been completed. Automated tests verify the integration rules but do not prove the full merchant lifecycle.

## Still required for paid launch

1. Publish the latest website main commit; the live auth page still contains the superseded $10 sentence.
2. Run one authorized live checkout and verify webhook persistence, CRM entitlement, seat proration, cancellation and refund, including tenant isolation.
3. Complete authenticated CRM read-back acceptance, publish extension 1.5.2 through the Chrome Web Store, obtain legal/tax review and establish recoverable database backups.
4. Only then set `BILLING_SALES_ENABLED=true`. No public paid-launch green light is warranted before these checks.
