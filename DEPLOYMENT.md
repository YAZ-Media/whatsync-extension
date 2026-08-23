# WhatSync deployment guide

Everything a deploy touches, in one place: the six Supabase edge functions,
how they authenticate, and the three ways to ship them.

## Architecture

The Chrome extension and the whatsync.io dashboard both talk to **edge
functions** hosted on the Supabase project `ogsvchujqpayuckxuwdf` (WhatSync).
The functions read and write user data in an **external Supabase project**
(the auth + data project) using its service-role key — every request carries a
JWT issued by that external project, and each function validates it itself.

Because of that, **platform JWT verification must stay OFF** for every
function (`verify_jwt = false`, pinned in `supabase/config.toml` and passed as
`--no-verify-jwt` on deploy). Turning it on would check tokens against the
edge project's own secret and reject every request at the gateway.

| Function | Purpose | Unauthenticated behavior |
|---|---|---|
| `hubspot` | Multi-tenant HubSpot proxy: contacts, notes, tickets, tasks, deals, templates, automations, sidebar fields, team management | HTTP 200 with `{ error, status: 401 }` body (supabase-js contract) |
| `hubspot-oauth` | HubSpot OAuth connect/callback/refresh, sync settings, owner resolution | HTTP 401 |
| `settings` | Workspace/privacy settings, data export, weekly digest, failure alerts | HTTP 401 when a `userId` is passed |
| `external-auth` | Sign in/up (with signed invite tokens), password reset, session refresh | Public by design (it IS the auth endpoint) |
| `billing` | Subscription, invoices, payment methods | HTTP 401 |
| `save-activity-config` | Activity-log table configuration | `get` public, `save` HTTP 401 + Owner/Admin only |

Shared code lives in `supabase/functions/_shared/` (`auth.ts`, `invites.ts`,
`notifications.ts`, `activityConfig.ts`) and is bundled into each function at
deploy time.

## Required secrets (Supabase → Edge Functions → Secrets)

- `EXTERNAL_SUPABASE_URL` / `EXTERNAL_SUPABASE_SERVICE_ROLE_KEY` — the auth/data project
- `HUBSPOT_CLIENT_ID` / `HUBSPOT_CLIENT_SECRET` / `HUBSPOT_REDIRECT_URI` — HubSpot OAuth app
- `RESEND_API_KEY` (+ optional `RESEND_FROM`, `RESEND_FROM_NAME`) — email notifications
- `INVITE_SIGNING_SECRET` — optional; invite/state signing falls back to the service-role key

## Three ways to deploy

### 1. CI (preferred once configured)

Every push to `main` touching `supabase/functions/**` runs
`.github/workflows/deploy-edge-function.yml`: it deploys all six functions and
then smoke-tests every live endpoint. It needs the **`SUPABASE_ACCESS_TOKEN`**
repository secret (GitHub → Settings → Secrets and variables → Actions;
create the token at https://supabase.com/dashboard/account/tokens). Until that
secret is set, every run fails at the first step by design.

The workflow can also be run manually from the Actions tab
(`workflow_dispatch`).

### 2. One-command script

```bash
SUPABASE_ACCESS_TOKEN=sbp_... ./deploy-edge-function.sh            # all six + smoke test
SUPABASE_ACCESS_TOKEN=sbp_... ./deploy-edge-function.sh hubspot    # just one + smoke test
./deploy-edge-function.sh smoke                                    # smoke tests only, no token needed
```

### 3. Supabase MCP (from a Claude session)

`mcp__Supabase__deploy_edge_function` with `verify_jwt: false`, the function's
`index.ts`, and whichever `_shared/*.ts` files it imports. Used when CI is
unavailable; the next CLI deploy simply supersedes it.

## Smoke tests

`./deploy-edge-function.sh smoke` (also the last CI step) checks, per
function: CORS preflight answers, the auth gate rejects sessionless requests
with the documented status, and the public endpoints (`external-auth`
dispatcher, `save-activity-config` `get`) answer correctly. Set
`SUPABASE_JWT` to a logged-in user's access token to add a full authenticated
`getTemplates` round-trip against `hubspot`.

## Database

`supabase/migrations/` and `db/` hold the schema (production schema +
security hardening) for reference; they target the external auth/data
project and are applied there, not through this repo's CI.
