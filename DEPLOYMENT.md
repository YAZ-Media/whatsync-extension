# WhatSync deployment

**Current package: 1.5.2 release candidate. Public checkout remains closed pending the final live acceptance transaction.**

Follow [the launch runbook](release/LAUNCH_RUNBOOK.md) and [readiness report](LAUNCH_READINESS.md). They supersede the older deployment instructions.

The extension and website both use `ogsvchujqpayuckxuwdf` for auth, data and edge functions. The website's Git repository is `YAZ-Media/whatsync-website`, checked out at `website/` within the main working folder. Lovable Cloud deploys to a different backend; deploy the WhatSync functions explicitly using the Supabase CLI.

Do not push an unreviewed migration directly into production. Inspect migration history, take a backup, apply the reviewed SQL, deploy matching functions, then publish the matching website and extension. The new billing code cannot operate without its migration and merchant configuration. Sales remain disabled by default.

`package-extension.sh` builds only the extension. `scripts/package-release.py` builds the combined candidate with website assets, backend source, checksums and launch instructions after the website production build and tests finish.

GitHub deployment is manual during launch acceptance. Configure the `production` environment and normal Supabase deployment credentials in repository settings. Never place service keys, merchant secrets, OAuth secrets or customer tokens in the extension, website bundle, tickets or chat.
