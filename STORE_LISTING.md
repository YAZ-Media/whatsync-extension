# Chrome Web Store submission — WhatSync 1.5.2

Submit this package for Chrome Web Store review while public checkout remains closed. Store approval is a separate launch gate; do not enable customer sales until the approved listing installs successfully and the live acceptance matrix in `LAUNCH_READINESS.md` passes.

## Proposed listing copy (verify against the accepted build)

Name: WhatSync — WhatsApp to HubSpot Sync

Summary: View HubSpot contacts beside WhatsApp Web and capture conversations, notes and follow-up tasks in your CRM.

Description: WhatSync helps teams keep CRM details close to their WhatsApp conversations. View the connected HubSpot contact, review locally detected contact details with their message source, and save selected messages or a note. Use your connected HubSpot account's owners and property options when creating contacts, tasks, tickets and deals. Templates insert a draft for you to review and send. Configured automation rules can create CRM actions after supported extension events.

A WhatSync account and a connected HubSpot account are required. Availability and pricing must match the published Pricing page. The extension reads the open WhatsApp Web chat and depends on its page structure; it is not a replacement for the WhatsApp Business Platform. Do not advertise guaranteed full historical sync, every customized HubSpot form, message delivery guarantees, HubSpot @mention notifications, certification or shared-portal access before validating those capabilities.

## Permission explanations

- `web.whatsapp.com`: renders the sidebar, reads the selected conversation and inserts user-selected template drafts.
- `whatsync.io` / `www.whatsync.io`: synchronizes session and dashboard preference changes with the extension.
- `ogsvchujqpayuckxuwdf.supabase.co`: authenticated WhatSync backend requests.
- `storage`: persistent session, preferences and local cache.
- `alarms`: session refresh scheduling.
- `tabs`, `activeTab`, `scripting`: supported page interactions and dashboard/auth navigation. Review each permission against the final implementation before submission; remove anything unused.

Single purpose: keep a connected HubSpot CRM updated from the user's WhatsApp Web work.

Prepare actual screenshots from the accepted build, the original icon, setup/support/privacy/terms URLs, and reviewer access. The combined release bundle is not the extension upload: upload only `dist/whatsync-1.5.2.zip`. Confirm the Chrome Web Store's current submission requirements in its developer dashboard; no approval or review time is promised here.
