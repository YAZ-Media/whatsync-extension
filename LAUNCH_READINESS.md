# WhatSync 1.5.1 — release candidate, NOT approved for public paid launch

Reviewed 12 September 2026. No zero-bug guarantee is possible. Passing local tests is not evidence that every live integration works. This package is suitable for controlled acceptance testing; sales stay closed by default.

## September 12 fixes

- Dashboard metadata uses the same external-auth session as other requests. Pipeline, owner and property errors offer retries; custom lead-status defaults are saved and applied to new contacts.
- Extension connection is required and detected by a same-account handshake on whatsync.io. Local previews explain that detection requires the published site.
- Inputs use 38px border-box height, contact markup is correctly nested, actions wrap with spacing. Empty chat scan results stay compact until explicitly scanned; already-filled suggestions are distinguished from absent details.
- All three sidebar groups have saved ordering, applied in the real extension and preview. Ticket is a direct sortable action; Templates replaces the generic More label.
- CRM writes require a valid active/trialing subscription with a future period end; no-plan/expired/overdue writes fail closed. Setup preferences and permitted CRM reads remain available. There is no customer-owner exemption and no automatic free trial implemented yet. Explicit server-allowlisted platform owners now have labelled internal access.
- Existing billing users no longer see Create workspace. Customer-facing plan and checkout messages use plain language.

- Owner console: account and integration health, registered users, recent error metadata, processed billing events, and Stripe configuration checks. See `release/OWNER_AND_STRIPE_STATUS.md` for scope and connection blockers.

## Changes delivered

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

Final local result: **55 automated tests passed** (12 Node, 14 Deno, 29 browser), plus the disposable database checks. The browser suite includes a fresh-profile MV3 service-worker and popup startup check.

Reproducible checks are in `tests/`, `supabase/tests/`, and `website/tests/`. The release bundle contains the final report files.

- Node regression tests: conservative extraction, short company names, template variables, rejected contact responses, secondary-log failure and transient refresh failure.
- Browser tests using fixture accounts and mocked CRM/payment responses: all nine dashboard routes; public navigation; mobile menu and overflow; real template create/edit/delete/search/export buttons; sidebar save payload; role restrictions; create-form validation and preserved errors; owner mismatch; rapid chat switching; message quotes/direction; session bridge and outage behavior; pricing and subscriber denial.
- Deno tests: signed/forged webhooks, provider re-fetch, failed storage retries, checkout price tampering, authentication/role rules, legacy card endpoint rejection and sales-closed state.
- Disposable PostgreSQL 14: migration, duplicate event replay, old event ordering, atomic failure, grants and RLS flags. Target project's actual PostgreSQL version/schema and deployed RLS still need acceptance testing.
- JavaScript syntax, TypeScript, production build, dependency advisory audit, ZIP manifest and backend-identity validation. Compiled production assets were also checked on Home, Setup, Auth, Pricing, Privacy and the protected Billing redirect with zero page errors (payment response mocked).
- Visual inspection: new public landing page and dark extension form fixture. This is not live WhatsApp end-to-end testing or a full accessibility certification.

The HubSpot, billing and external-auth functions have now been deployed directly to WhatSync (`ogsvchujqpayuckxuwdf`). The verified-billing and profile-privilege migrations were rehearsed with rollback, then applied transactionally and recorded. A third, locally tested migration adds a service-only checkout reservation so retries reuse the same provider request across time boundaries. Live checks confirm four billing tables, blocked browser role/workspace changes, and restricted OAuth token reads. Seven unauthenticated endpoint checks passed: sales closed, private billing/subscribers denied, invalid sessions denied, CRM writes denied, scheduler denied, and unconfigured webhook rejected. The webhook result proves rejection only; Stripe signature delivery still needs configured-provider acceptance.

The review found that existing self-profile policies allowed changing role and organization. The new column grants close that path while preserving personal edits and service-side account management. Current functions were downloaded to `/tmp/whatsync-prelaunch-backup` for rollback. The project reported no available physical backups and PITR disabled. Establish and verify recoverable backups before paid launch.

Latest local browser run: all 22 tests passed after the page-title fix. Initial sandbox attempts could not start Chromium; the isolated-browser rerun succeeded. Nine billing tests and two new signup tests also passed. The real extension popup signup test verifies the shared server path and email-confirmation messaging. Signup now uses a fresh server client for protected workspace creation, and database failures are reported instead of appearing successful. No live charge or authenticated CRM save/read-back has been performed.

## Gates before a green light

1. **Publish and complete acceptance.** HubSpot/billing/auth and the four reviewed migrations are deployed to the correct backend. Website publication and Chrome extension rollout remain pending. Publish from YAZ-Media/whatsync-website; reload the extension from this main folder or install the candidate ZIP. Lovable Cloud deploy buttons target its managed backend and are not sufficient. Historical live schema had no migration-history entries; do not replay old migrations blindly.
2. **Confirm the paid offer and configure a provider.** Stripe is the proposed implementation, not a confirmed merchant account. Approve plan prices, currency, monthly/yearly period, per-workspace/per-seat unit, trial, taxes, refunds and cancellation terms. Configure Stripe secrets/prices/webhooks/portal and an operator user ID. Three plan names are supported; differentiated seat/usage entitlements are not implemented. Do not sell quotas or premium tiers that the server does not enforce.
3. **Payment acceptance.** In Stripe test mode verify checkout success, decline, authentication challenge, abandoned/duplicate checkout (including simultaneous clicks and reservation expiry), renewal, plan change, failed renewal, cancellation, refund, duplicate/out-of-order webhooks, and subscriber-table results. Then perform an approved live-mode merchant acceptance transaction and cancellation/refund. No live charge or refund was performed in this session. Do not mark old simulated invoices as paid or migrate them into verified subscriptions.
4. **Live CRM and tenant acceptance.** With an unlocked browser, run the matrix below against dedicated HubSpot test records and two separate customer accounts. A signed-in WhatSync session connected to a dedicated HubSpot acceptance portal is still needed. Check token rotation over an extended session and two browser tabs. Verify wrong-tenant and suspended/read-only users cannot mutate CRM records.
5. **Feature acceptance.** Tasks, notes, WhatsApp logs, meetings, tickets, deals, team invites, workspace export/retention, privacy settings, owner modes, automation actions and scheduled sweeps require actual save/read-back tests. Browser fixture tests do not prove delivery. HubSpot @mentions/notification delivery in notes is not implemented/verified; do not advertise it. The create form uses core fields and live property options; it does not reproduce an account's private custom HubSpot create-layout configuration.
6. **Policy and store requirements.** Approve the business's Terms of Service, billing/refund policy, privacy disclosures, support mailbox, data processing obligations and extension permissions. Terms of Service are not yet published. Verify privacy claims against deployed storage and automatic logging. Rotate credentials previously exposed in conversation using provider dashboards. Complete Chrome Web Store approval before HubSpot listing submission.
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
