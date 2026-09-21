# Launch execution — production is deployed; finish the external gates

## Files and ownership

- Main folder: `/Users/yazbassam/Development/whatsync`. Extension code lives here. Do not load the deleted .claude worktree.
- Website: `website/` inside this folder, a separate checkout of `YAZ-Media/whatsync-website`.
- Canonical backend release source: root `supabase/`; function files are checked for parity with `website/supabase/functions/` before packaging.
- Auth, database and deployed functions: WhatSync `ogsvchujqpayuckxuwdf`.
- `website/src/lib/backend.ts` and extension `config.js` contain only public anonymous keys. Privileged secrets belong only in Supabase secrets/merchant dashboards.

## Deployment status — 21 September 2026

- Complete: live WhatSync schema/permissions inspected; billing and profile-privilege migrations applied; HubSpot, billing, OAuth, settings and external-auth deployed to `ogsvchujqpayuckxuwdf`.
- Verified: browser role/workspace changes denied; OAuth token reads restricted; private/scheduler endpoints reject unauthorized requests. Pricing returns the live USD 19 monthly and USD 180 annual plans. Stripe credentials, prices, signed webhook and portal are configured on the correct backend.
- Complete: live Stripe product and prices, live signed webhook, default customer portal, subscription terms acceptance, paid-role seat enforcement and prorated self-service seat changes.
- Complete: HubSpot's signed privacy-deletion webhook is deployed and configured to purge stored activity for the deleted contact across the connected workspace.
- Complete: DigitalOcean deployed website commit `32008c4`; Chrome Web Store version 1.5.3 is public.
- In progress: Namecheap now uses Cloudflare nameservers and Cloudflare has started its verification cycle. Until `.io` delegation propagates, the public domain continues serving the previous deployment.
- Remaining: verify the completed DNS cutover, wait for Google trader verification, obtain a third qualifying HubSpot install, complete one controlled purchase/cancel/refund lifecycle, obtain qualified legal/tax review, and establish recoverable backups.
- The database's historical schema existed with an empty migration journal. Only the four reviewed September migrations are recorded. **Do not run blanket db push until historical migrations are reconciled.** The commands below describe future releases and must not be used to replay the old baseline on this database.

CRM-write subscription enforcement is mandatory, independent of the legacy BILLING_ENFORCE_ACCESS flag. An account without a valid subscription can set up and read but cannot write to HubSpot. Stripe trials are respected; a no-card trial is not implemented.

Reload the extension from the main folder to use v1.5.5, then refresh WhatsApp Web. Lovable Cloud function deployments still target the wrong database and are not the deployment path for backend changes.

## 1. Validate the candidate locally

Use Node >=22.12, npm, Deno, and PostgreSQL for the optional disposable database test. From the main folder:

```sh
cd website
npm ci
npx playwright install chromium
npm run dev -- --host 127.0.0.1 --port 4173
```

In a second terminal from the main folder:

```sh
node --test tests/*.test.cjs
deno test --allow-env supabase/tests/*.test.ts
cd website
npx tsc --noEmit
npx playwright test
npm audit
npm run build
```

Browser tests use fixtures and do not send live CRM data, messages or charges. The SQL test creates temporary roles and rolls back; run it only in a new disposable database as described in its file, never in production.

## 2. Configure and deploy the WhatSync backend

Use an authenticated Supabase CLI session through normal login (no copied access tokens in chat). First verify the linked project in the dashboard and CLI. In the main folder:

```sh
supabase link --project-ref ogsvchujqpayuckxuwdf
supabase migration list --linked
supabase db push --linked --dry-run
```

Stop if historical migrations conflict or the plan includes unexpected objects. Compare existing migration history and schema; do not blindly run every historical SQL file. Back up the live database, reconcile migration history, then apply the reviewed changes:

```sh
supabase db push --linked
supabase functions deploy hubspot --project-ref ogsvchujqpayuckxuwdf --no-verify-jwt
supabase functions deploy billing --project-ref ogsvchujqpayuckxuwdf --no-verify-jwt
```

Application code validates the JWT and role. The billing gateway must allow public pricing and signed Stripe webhooks; webhook signatures are verified separately. Gateway JWT verification being off is not permission to omit application authentication.

Deploy other root functions only after reviewing their diff/configuration against the currently deployed version. HubSpot OAuth must point to `https://whatsync.io/auth/hubspot/callback` and use the app's public OAuth client. Verify EXTERNAL_SUPABASE_URL and EXTERNAL_SUPABASE_SERVICE_ROLE_KEY both belong to WhatSync, not Lovable Cloud. Existing HUBSPOT_CLIENT_ID, HUBSPOT_CLIENT_SECRET and redirect settings are still required.

Lovable Cloud cannot be repointed merely by editing supabase/config.toml. GitHub sync is for source; backend deployment still needs the explicit WhatSync project above.

## 3. Verify production subscriptions

Production currently has `BILLING_SALES_ENABLED=true`. Set it to `false` immediately if merchant acceptance exposes a billing defect. Required server secrets:

| Setting | Purpose |
| --- | --- |
| STRIPE_SECRET_KEY | Live merchant secret key |
| STRIPE_WEBHOOK_SECRET | Signing secret for the billing function URL |
| STRIPE_PRICE_PRO_MONTHLY / STRIPE_PRICE_PRO_ANNUAL | Active recurring per-user Stripe Price IDs; no client-supplied amount |
| APP_URL | `https://whatsync.io` |
| BILLING_ADMIN_USER_IDS | Comma-separated authenticated WhatSync user UUIDs allowed to view all subscribers |
| BILLING_ENFORCE_ACCESS | Retired: CRM-write subscription checks are always enforced |
| BILLING_REQUIRE_LIVE | `true` for paid production |

The hosted billing portal supports invoices, payment-method updates and cancellation at period end. Seat quantity is selected in checkout, verified from Stripe webhooks and can be changed from WhatSync with Stripe proration. Configure automatic tax and invoicing according to the merchant's approved setup; these are not enabled by this code by default.

The live webhook URL is `https://ogsvchujqpayuckxuwdf.supabase.co/functions/v1/billing` for checkout.session.completed, customer.subscription.created/updated/deleted, invoice.paid and invoice.payment_failed. Webhooks use the raw request body and Stripe signature. HTTP 500 responses must be retried and monitored.

Checkout reservations last one hour. Retries use the same stored ID/expiry and provider request key. A different plan is rejected while the reservation is active; the buyer can resume the original plan or wait for expiry. If the first provider call never happened, a very late retry may fail until the reservation expires because Stripe requires at least 30 minutes for a newly created session. Validate these outcomes with real test-mode Stripe sessions before opening sales. [Stripe checkout expiry reference](https://docs.stripe.com/api/checkout/sessions/create).

Run the payment acceptance matrix in LAUNCH_READINESS.md. The subscriber page is `/dashboard/subscribers`; normal workspace Owner access is deliberately insufficient. Use `/dashboard/billing` for customer self-service. These pages require this new function and migration to be deployed.

Live merchant keys, price IDs, webhook secret and `BILLING_REQUIRE_LIVE=true` are configured. Sign into a non-operator test workspace, temporarily open sales for the controlled transaction, and verify checkout → webhook → subscription → CRM entitlement → seat change → cancellation/refund. Then set `BILLING_SALES_ENABLED=true` for launch. Do not change price IDs used by existing subscriptions without a historical price mapping.

## 4. Publish the website and extension

Build/publish from `YAZ-Media/whatsync-website`. Confirm that the published assets target `ogsvchujqpayuckxuwdf`. The release ZIP includes static website assets; configure the host to serve index.html for client routes such as `/auth/hubspot/callback` and `/dashboard/billing`. Keep browser-server secrets out of the build.

Chrome Web Store version 1.5.3 is public. Keep the approved listing URL in `VITE_CHROME_STORE_URL` and verify the Setup page's Install button after the DNS cutover. Google trader verification remains pending, so the public listing temporarily carries Google's non-trader label. For local acceptance, use Chrome Extensions → Developer mode → Load unpacked → this main folder, then reload WhatsApp Web. Publishing the website does not update an unpacked extension.

Before accepting money, publish approved Terms, billing/refund policy and the updated privacy policy; confirm support works and every public URL resolves. Conduct a clean-device install and full purchase→connect→create→read-back flow.

## 5. Sell through a staged launch

Recommendation: begin with a small, directly supported pilot after technical acceptance. Use the website for checkout and the Chrome Web Store for installation, then recruit three independent businesses that use the integration in real work. Measure successful CRM saves, support issues, retained installs and willingness to pay before expanding.

HubSpot requires at least three active unique unaffiliated production installs with successful qualifying activity in the previous30days, OAuth, working setup/support/terms/privacy URLs, matching public pricing, and an approved browser-store extension. Listing is reviewed; it is not a guaranteed source of customers or a replacement for checkout. [Official listing requirements](https://developers.hubspot.com/docs/apps/developer-platform/list-apps/listing-your-app/app-marketplace-listing-requirements).

A current announcement says new legacy-app listings will be rejected from November2,2026. Inspect the existing OAuth app's platform type and migrate before submission if necessary. [HubSpot developer announcement](https://community.hubspot.com/t/changes-to-marketplace-submission-flow-how-active-installs-are-determined/156427).

After acceptance, use CRM consultants/agencies, a short install-and-first-save demo, and targeted HubSpot/WhatsApp search content to support discovery. Track activation and retention; marketplace presence alone does not demonstrate product demand.

## Rollback and operations

Keep the previous extension ZIP and website build. If billing fails, close sales with BILLING_SALES_ENABLED=false; preserve webhook ingestion and billing tables so charges remain reconcilable. Never restore simulated payment handlers. Restore only compatible prior functions after reviewing schema dependencies. Do not drop subscription/event tables during rollback. Maintain backups, webhook failure alerts, daily delivery checks, a support owner and a documented customer-data deletion process.
