# Owner access and Stripe readiness — September 12, 2026

## Verified

- Stripe browser session belongs to YAZ MARKETING LLC; testing mode is available and selected. No real payment was attempted.
- Live WhatSync secret inventory contains the owner allowlist and closed-sales flag, but no Stripe API key, webhook signing secret or price IDs.
- The configured owner allowlist matches yazan@yazmedia.com, user UUID 26ca8f7d-528b-4155-a840-db9d09d5aac2. The profile is Active with Owner role.
- Internal owner access is explicit and restricted to that server allowlist. It enables the owner's own CRM operations without manufacturing a paid subscription. Suspended owner accounts are still blocked.
- Customer workspace Owner roles do not confer platform ownership or customer-wide visibility.

## Internal console

`/dashboard/subscribers` is now labelled Owner console. It provides registered and active user counts, connected HubSpot users, current live subscriptions, paginated email search across accounts, roles/status, portal connection status, reported extension version and last activity, recent error metadata, and processed billing events. It also checks Stripe account identity, prices, webhook registration, portal configuration and live-mode readiness. Missing configuration is shown explicitly.

It does not expose API keys, OAuth tokens, chat bodies or raw error messages. Account suspension, refunds and customer impersonation are not implemented in this console. Use the merchant dashboard for financial operations; do not describe the console as supporting actions it does not yet offer.

## Connection handoff

The Supabase GitHub sign-in was explicitly approved but GitHub needs the user's interactive sign-in. A separate approval was requested to read Stripe test credentials and transfer them directly into Supabase's encrypted secret inputs, without displaying them in chat. Both tabs remain open.

No test payment, webhook delivery, renewal, failure recovery or cancellation has yet been completed against Stripe. The owner-console and billing tests use isolated fixtures; they do not prove the live payment flow.

## Still required for paid launch

1. Complete secure Stripe credential, matching price, webhook and WhatSync-specific portal configuration. Set STRIPE_ACCOUNT_ID to acct_1Ij3iXAMnTzu6DkV and STRIPE_PORTAL_CONFIGURATION_ID to a dedicated WhatSync configuration. Do not alter another business/product's portal defaults.
2. Implement/approve the commercial offer. Current fixed Starter/Team/Business checkout is not the proposed Pro per-seat monthly/annual model; seats and the automatic no-card trial remain unimplemented.
3. Run real sandbox checkout, signed webhook, declined payment, renewal, cancellation and refund acceptance, including tenant isolation. Keep test customers separate from live customers.
4. Publish the reviewed website branch, complete authenticated CRM read-back acceptance, publish the extension through the store, finalise legal/invoice disclosures, and establish recoverable database backups.
5. Only then open public sales. No paid-launch green light is warranted at this stage.
