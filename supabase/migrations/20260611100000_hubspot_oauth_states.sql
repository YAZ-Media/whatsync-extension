-- =============================================================================
-- WhatSync — HubSpot OAuth state table (External Supabase: ogsvchujqpayuckxuwdf)
-- =============================================================================
--
-- PURPOSE
--   The HubSpot OAuth callback is a browser redirect (GET) with no auth header,
--   so it cannot identify the user from a JWT. Instead, when an authenticated
--   user starts the connect flow we mint a random `state` nonce and remember
--   which user it belongs to. The callback looks the nonce up, attaches the
--   tokens to that user, and deletes the row. This prevents an attacker from
--   completing OAuth and binding their HubSpot to someone else's account.
--
--   Rows are short-lived (consumed on callback) and only ever touched by the
--   edge function via the service role — never by clients.
--
-- WHERE TO RUN
--   SQL Editor on the External project (ogsvchujqpayuckxuwdf).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.hubspot_oauth_states (
  state text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  redirect_to text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hubspot_oauth_states_created_at
  ON public.hubspot_oauth_states (created_at);

-- Service-role only: RLS on, no client policies. The edge function uses the
-- service role and bypasses RLS; clients get no access at all.
ALTER TABLE public.hubspot_oauth_states ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.hubspot_oauth_states FROM anon, authenticated;
GRANT ALL ON public.hubspot_oauth_states TO service_role;

-- =============================================================================
-- END
-- =============================================================================
