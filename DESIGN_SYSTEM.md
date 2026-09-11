# WhatSync design system — 1.5.0 candidate

Purpose: help sales, account management, and customer-success teams keep HubSpot accurate while talking in WhatsApp.

Brand: an original chat/check mark. Coral-to-apricot gradient (#FF7A59 → #FFAD85), navy (#213343), warm white surfaces. Dark coral (#B94025) for text and primary controls on white. Green is reserved for established success/WhatsApp semantics, not the WhatSync brand. Do not imply HubSpot certification or affiliation.

Typography: clear headings, compact form labels, readable 14px controls; preserve WhatsApp's host typography outside extension surfaces. Minimum 42px field height, visible keyboard focus, reduced-motion support. Dark sidebar uses navy surfaces and light text.

Interaction rules:
- Clear the previous contact immediately when the selected chat changes. Discard stale responses before rendering.
- Show loading, unavailable, no-match and saved states separately. A CRM record ID is required to show a successful save.
- Show inferred details with their source and an explicit Use/Save action. Never treat shared articles, forwarded text, outgoing messages or link domains as the customer's identity.
- Email is required. Email, First name, Last name appear in that order. Last name is optional.
- Owner labels must describe the resolved assignment. A creator match requires an active HubSpot owner with the same account email.
- Dynamic menus use real HubSpot values and show a retry on failure.
- Shared-data examples on marketing pages must be labelled as examples.
- Payments use hosted checkout; redirect completion alone is not proof of payment.

Sources: extension `content.css`, `icons/mark.svg`, website `src/index.css`. Generate all raster icon sizes with `node scripts/render-brand.mjs` after installing website dependencies. This renders the original vector; no HubSpot logo is embedded in the brand.
