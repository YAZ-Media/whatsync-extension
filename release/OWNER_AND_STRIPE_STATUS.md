# Owner access and Stripe readiness — September 12, 2026

## Verified

- Stripe browser session belongs to YAZ MARKETING LLC; testing mode is available and selected. No real payment was attempted.
- The WhatSync production backend now has the Stripe test API key and the matching test webhook signing secret stored as encrypted Edge Function secrets. Neither credential was copied into source code or release artifacts.
- A dedicated test webhook destination is active at `https://ogsvchujqpayuckxuwdf.supabase.co/functions/v1/billing` for the six required subscription, checkout and invoice events. It uses snapshot payloads and Stripe API version `2024-06-20`.
- A signed `invoice.paid` sandbox event reached the deployed WhatSync billing function and received HTTP 200 with `{"received":true}`. This proves transport and signature verification; it does not prove a WhatSync subscription checkout because the generated invoice was not attached to a WhatSync customer subscription.
- The configured owner allowlist matches yazan@yazmedia.com, user UUID 26ca8f7d-528b-4155-a840-db9d09d5aac2. The profile is Active with Owner role.
- Internal owner access is explicit and restricted to that server allowlist. It enables the owner's own CRM operations without manufacturing a paid subscription. Suspended owner accounts are still blocked.
- Customer workspace Owner roles do not confer platform ownership or customer-wide visibility.

## Internal console

`/dashboard/subscribers` is now labelled Owner console. It provides registered and active user counts, connected HubSpot users, current live subscriptions, paginated email search across accounts, roles/status, portal connection status, reported extension version and last activity, recent error metadata, and processed billing events. It also checks Stripe account identity, prices, webhook registration, portal configuration and live-mode readiness. Missing configuration is shown explicitly.

It does not expose API keys, OAuth tokens, chat bodies or raw error messages. Account suspension, refunds and customer impersonation are not implemented in this console. Use the merchant dashboard for financial operations; do not describe the console as supporting actions it does not yet offer.

## Connection status

The Supabase and Stripe sessions are connected. The Stripe test API key, account ID and webhook signing secret are configured against the correct WhatSync backend (`ogsvchujqpayuckxuwdf`). Signed webhook delivery is verified. Public sales remain deliberately closed.

No WhatSync checkout, subscription renewal, failure recovery or cancellation has yet been completed against Stripe. The owner-console and billing tests use isolated fixtures; together with the signed delivery test they verify the integration boundary, but they do not prove the full purchase lifecycle.

## Still required for paid launch

1. Create matching WhatSync recurring test prices and a WhatSync-specific customer portal configuration. Set the resulting price IDs and `STRIPE_PORTAL_CONFIGURATION_ID`. Do not alter another business/product's portal defaults.
2. Implement/approve the commercial offer. Current fixed Starter/Team/Business checkout is not the proposed Pro per-seat monthly/annual model; seats and the automatic no-card trial remain unimplemented.
3. Run real sandbox checkout, signed webhook, declined payment, renewal, cancellation and refund acceptance, including tenant isolation. Keep test customers separate from live customers.
4. Publish the reviewed website branch, complete authenticated CRM read-back acceptance, publish the extension through the store, finalise legal/invoice disclosures, and establish recoverable database backups.
5. Only then open public sales. No paid-launch green light is warranted at this stage.
