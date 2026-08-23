# Chrome Web Store submission guide

Everything needed to publish WhatSync, so teammates get automatic updates
instead of `git pull` + manual reloads.

## One-time setup

1. Register a Chrome Web Store developer account (one-time $5) at
   https://chrome.google.com/webstore/devconsole with the yazmarketing Google
   account.
2. Run `./package-extension.sh` — it produces `dist/whatsync-<version>.zip`
   containing only the shipped files (icons included).
3. Upload the zip, fill in the listing below, and pick **Unlisted** visibility
   (installable via direct link — right for an internal team tool; switch to
   Public later if WhatSync goes commercial).

Each release afterwards: bump `manifest.json` version → `./package-extension.sh`
→ upload the new zip. Chrome pushes the update to every installed browser
within hours.

## Listing copy

**Name:** WhatSync — WhatsApp to HubSpot Sync

**Summary (132 chars max):**
See HubSpot context beside every WhatsApp chat and log conversations, deals,
tasks and tickets without leaving WhatsApp Web.

**Description:**
WhatSync puts your HubSpot CRM inside WhatsApp Web. Open a chat and instantly
see who you're talking to: contact details, owner, lifecycle stage, deals with
live stage names, recent activity. Log the conversation as a native HubSpot
WhatsApp message in one click — or let WhatSync spot chats worth recording
(pricing, proposals, approvals — English and Arabic) and suggest it. Create
notes, tasks, tickets and deals inline, send message templates, and run
automation rules on real conversation events. Team-ready: workspace roles,
shared HubSpot connection, and privacy controls (phone masking, media
redaction, retention).

Requires a WhatSync account (whatsync.io) and a HubSpot portal.

**Category:** Workflow & Planning · **Language:** English

## Permission justifications (the review form asks for each)

| Permission | Justification |
|---|---|
| `host: web.whatsapp.com` | Renders the CRM sidebar beside chats and reads the open conversation to match the contact and log messages the user chooses to log. |
| `host: whatsync.io` | Dashboard bridge: sidebar layout changes made on the WhatSync dashboard apply to the extension immediately. |
| `host: *.supabase.co` | WhatSync's backend API (authentication and HubSpot proxy). |
| `storage` | Caches session, settings, and per-chat bookmarks locally. |
| `alarms` | Periodic settings refresh. |
| `tabs` / `activeTab` / `scripting` | Opens the dashboard/OAuth flows and injects the sidebar. |

**Single purpose:** connect WhatsApp Web conversations to the user's HubSpot
CRM.

**Data use disclosures:** the extension transmits conversation text only when
the user logs it (or has explicitly enabled auto-logging) to the user's own
HubSpot portal via WhatSync's backend; credentials are OAuth tokens; no data
is sold or shared with third parties. Privacy policy: https://whatsync.io/privacy

## Assets checklist

- Icon 128×128: `icons/icon128.png` (shipped in the zip) ✓
- Screenshots (1280×800, 3–5): capture the sidebar on a real chat — contact
  card, deal card with stage badge, smart log suggestion, activity timeline,
  and the dashboard's Sidebar Designer.
- Promo tile 440×280: optional for Unlisted.
