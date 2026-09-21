# WhatSync 1.5.6 — production deployment, launch blockers tracked

Reviewed 21 September 2026. No zero-bug guarantee is possible. Passing automated tests is not proof that every third-party integration will remain available, but all known release defects have been addressed and the remaining external launch gates are listed below.

## September 12 fixes

- Dashboard metadata uses the same external-auth session as other requests. Pipeline, owner and property errors offer retries; custom lead-status defaults are saved and applied to new contacts.
- Extension connection is required and detected by a same-account handshake on whatsync.io. Local previews explain that detection requires the published site.
- Inputs use 38px border-box height, contact markup is correctly nested, actions wrap with spacing. Empty chat scan results stay compact until explicitly scanned; already-filled suggestions are distinguished from absent details.
- All three sidebar groups have saved ordering, applied in the real extension and preview. Ticket is a direct sortable action; Templates replaces the generic More label.
- CRM writes require a valid active/trialing subscription with a future period end; no-plan/expired/overdue writes fail closed. Setup preferences and permitted CRM reads remain available. There is no customer-owner exemption and no automatic free trial implemented yet. Explicit server-allowlisted platform owners now have labelled internal access.
- Existing billing users no longer see Create workspace. Customer-facing plan and checkout messages use plain language.

- Owner console: account and integration health, registered users, recent error metadata, processed billing events, and Stripe configuration checks. See `release/OWNER_AND_STRIPE_STATUS.md` for scope and connection blockers.

## Changes delivered

- Sidebar Appearance now uses direct drag-and-drop ordering with an always-visible fictional-data preview that mirrors enabled fields, quick actions and sections without reading customer CRM data. Companies, related Contacts, Lead Stage Tracker and Attachments are configurable, lazy-loaded extension sections backed by the connected HubSpot portal.
- Coral/apricot/navy brand, new original icons, redesigned marketing pages, dashboard navigation, extension sidebar and popup styling; public setup guide.
- Conservative chat suggestions with source evidence and review; corrected template-variable substitution and quote/sender extraction. Company/job/name are no longer guessed from article headlines or arbitrary URLs.
- Immediate chat-switch loading state, stale-response rejection, short metadata caching, removal of redundant contact requests.
- Email-first form, optional last name, real enum choices with retry, honest owner assignment, preserved failed forms. A created record is opened directly from HubSpot's response rather than waiting for search indexing.
- Company names save on the contact. Optional company linking reuses a single exact existing company match. It does not create unassociated name-only companies. Missing/ambiguous/failed associations are reported for review.
- Sidebar field/privacy saves now refresh all affected controls; an empty allowed-fields list remains empty. The unimplemented media-redaction toggle was removed from the UI.
- Shared dashboard refresh coordination, worker/session bridge synchronization, and preservation of credentials during temporary outages.
- Website and extension pinned to the same WhatSync backend. Local website config previously pointed to Lovable's different project.
- Replaced simulated payment/card flows with Stripe-hosted checkout and customer portal, signed webhook verification, private subscription storage, replay/ordering protection, mandatory server subscription enforcement for CRM writes, and an operator-only subscriber page with billing email and status filters.
- Patched website dependencies. No known vulnerabilities reported by npm audit at validation time; this is not a guarantee that dependencies have no defects.

## Verification evidence

Final local result: **78 automated tests passed** (12 Node, 23 Deno, 43 browser), plus the previously completed disposable database checks. The browser suite includes a fresh-profile MV3 service-worker and popup startup check.

Reproducible checks are in `tests/`, `supabase/tests/`, and `website/tests/`. The release bundle contains the final report files.

- Node regression tests: conservative extraction, short company names, template variables, rejected contact responses, secondary-log failure and transient refresh failure.
- Browser tests using fixture accounts and mocked CRM/payment responses: all nine dashboard routes; public navigation; mobile menu and overflow; real template create/edit/delete/search/export buttons; sidebar save payload; role restrictions; create-form validation and preserved errors; owner mismatch; rapid chat switching; message quotes/direction; session bridge and outage behavior; pricing and subscriber denial.
- Deno tests: signed/forged Stripe and HubSpot privacy webhooks, replay rejection, provider re-fetch, failed storage retries, checkout price tampering, authentication/role rules and legacy card endpoint rejection.
- Disposable PostgreSQL 14: migration, duplicate event replay, old event ordering, atomic failure, grants and RLS flags. Target project's actual PostgreSQL version/schema and deployed RLS still need acceptance testing.
- JavaScript syntax, TypeScript, production build, dependency advisory audit, ZIP manifest and backend-identity validation. Compiled production assets were also checked on Home, Setup, Auth, Pricing, Privacy and the protected Billing redirect with zero page errors (payment response mocked).
- Visual inspection: new public landing page and dark extension form fixture. This is not live WhatsApp end-to-end testing or a full accessibility certification.

The HubSpot, billing and external-auth functions are deployed directly to WhatSync (`ogsvchujqpayuckxuwdf`). The reviewed billing, profile-privilege, checkout-reservation and Pro per-seat migrations are applied and recorded. Live checks confirm the billing schema, blocked browser role/workspace changes, restricted OAuth token reads and denied unauthenticated CRM access. Live Stripe prices are USD 19 monthly and USD 180 annually per syncing user, and the public catalog is open. The live Stripe webhook and customer portal are active. HubSpot privacy deletions now use a v3-signed webhook that removes stored contact activity across the connected workspace. Invitations, role activation and invite acceptance enforce paid capacity; owners can change seats with Stripe proration.

The review found that existing self-profile policies allowed changing role and organization. The new column grants close that path while preserving personal edits and service-side account management. Current functions were downloaded to `/tmp/whatsync-prelaunch-backup` for rollback. The project reported no available physical backups and PITR disabled. Establish and verify recoverable backups before paid launch.

Latest local browser run: all 43 tests passed, including the installed MV3 extension and paid-seat controls. Twenty-three backend tests and 12 extension tests also passed. The real extension popup signup test verifies the shared server path and email-confirmation messaging. Signup uses a fresh server client for protected workspace creation, and database failures are reported instead of appearing successful. A complete purchase, renewal, failure, cancellation and refund cycle still requires controlled merchant acceptance.

## Gates before a green light

1. **Complete the public-domain cutover.** Namecheap now has `corey.ns.cloudflare.com` and `dana.ns.cloudflare.com`, DNSSEC has no parent DS record, and Cloudflare is checking the change. Until `.io` delegation propagates, `whatsync.io` continues serving the previous deployment. After activation, verify that the public site serves DigitalOcean asset `assets/index-DcNSIY2c.js` and that every public route works over HTTPS.
2. **Complete marketplace verification.** Chrome Web Store version 1.5.3 is public. Google trader verification was submitted and remains pending, so the public listing temporarily shows the publisher as non-trader. The HubSpot listing remains blocked at 2 of 3 qualifying active installs and needs one independent production customer install with real app activity.
3. **Complete commercial acceptance.** The WhatSync Pro offer is live at USD 19 per syncing user monthly or USD 180 annually. Run one controlled non-operator checkout through webhook persistence, CRM entitlement, seat increase, cancellation and refund/read-back. Validate UAE tax treatment and legal disclosures before broad paid promotion.
4. **Live CRM and tenant acceptance.** Run the matrix below against dedicated HubSpot test records and two separate customer accounts. Check token rotation over an extended session and two browser tabs. Verify wrong-tenant and suspended/read-only users cannot mutate CRM records.
5. **Feature acceptance.** Tasks, notes, WhatsApp logs, meetings, tickets, deals, team invites, workspace export/retention, privacy settings, owner modes, automation actions and scheduled sweeps require actual save/read-back tests. Browser fixture tests do not prove delivery. HubSpot @mentions/notification delivery in notes is not implemented/verified; do not advertise it. The create form uses core fields and live property options; it does not reproduce an account's private custom HubSpot create-layout configuration.
6. **Policy and store requirements.** Terms and Privacy are published with YAZ MARKETING LLC, TRN 100528135500003, the registered address and support@whatsync.io. Obtain qualified legal/tax review, verify privacy claims against deployed behavior, rotate credentials previously exposed in conversation, and wait for Google trader verification before broad EEA promotion.
7. **Operate the service.** Verify scheduler deployment and notification delivery, backups/restore, webhook alerting, rate-limit recovery, deletion requests and support ownership. Confirm real operational performance and concurrent-user load; no production load test was run.

## Live acceptance matrix

For every save: record the source account/portal, record ID, request result, and HubSpot read-back; clean up the dedicated test records afterwards. Avoid customer messages while testing.

| Journey | Required evidence |
| --- | --- |
| Sign up / confirm / sign in / reset / sign out | Fresh-user flow and emails delivered; revoked session cannot be reused |
| HubSpot connect / reconnect / disconnect | Correct portal and scopes, refresh succeeds, disconnect removes access |
| Chat detection | Saved, unsaved, international/00 numbers, mobilephone-only, duplicate names, group chats, rapid A→B→A switches |
| Create / duplicate / edit contact | Required email, optional last name, phone normalization, exact selected owner/enums, no read-only property writes, duplicate prevention and preserved failures |
| Suggested details | Articles, third-party signatures, quotes and outgoing text ignored; source is reviewable; selected values saved exactly |
| Notes / WhatsApp activity | Selected message direction/time/body/association correct, no quoted duplication; failed requests visible; no false success |
| Task / meeting / ticket / deal | All required fields, pipeline/stage/owner IDs, timezone and association verified by read-back |
| Templates | Real values substituted, missing values reported; insertion never sends a message automatically |
| Automations | Every trigger/action/condition, duplicate-event behavior, failure reporting, scheduled inactivity and subscription enforcement |
| Sidebar / privacy | Designer changes reach extension; masking, allowed fields, retention and export work for intended tenant |
| Team / permissions | Invite lifecycle; every role; suspended account; cross-workspace ID tampering denied |
| Billing / subscribers | Provider test matrix above, operator-only global listing, customer sees only its account, entitlement enforcement |
| Browser lifecycle | Fresh install, update, service-worker sleep, offline recovery, extension reload, overnight session and multiple tabs |

See `release/LAUNCH_RUNBOOK.md` for the execution order and marketplace path.
