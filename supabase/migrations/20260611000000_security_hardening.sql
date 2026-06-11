-- =============================================================================
-- WhatSync — Security Hardening Migration (External Supabase)
-- =============================================================================
--
-- PURPOSE
--   1. Stop client sessions from reading HubSpot OAuth tokens. Tokens are only
--      needed by edge functions (service role); exposing them to the browser
--      means any XSS or compromised extension page could exfiltrate them.
--   2. Add the missing DELETE policies so users can disconnect HubSpot and
--      clear their own activity history (GDPR/data-deletion support).
--
-- WHERE TO RUN
--   Supabase Dashboard → SQL Editor on the **External Supabase** project,
--   after 20260605000000_production_schema.sql.
--
-- CLIENT IMPACT
--   After this migration, `select('*')` on hubspot_connections FAILS for
--   authenticated clients (permission denied on the token columns).
--   Dashboards/extension code must select explicit columns, e.g.:
--     .select('id, user_id, portal_id, expires_at, scopes, status, connected_at')
--   The WhatSync extension already reads connection status via edge functions
--   only, so it is unaffected.
--
-- SAFE TO RE-RUN
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Column-level privileges: hide OAuth tokens from client sessions
-- -----------------------------------------------------------------------------
REVOKE SELECT ON public.hubspot_connections FROM authenticated;
GRANT SELECT (id, user_id, portal_id, expires_at, scopes, status, connected_at, created_at, updated_at)
  ON public.hubspot_connections TO authenticated;

-- Clients may flip status (e.g. disconnect) but never write token material.
REVOKE UPDATE ON public.hubspot_connections FROM authenticated;
GRANT UPDATE (status) ON public.hubspot_connections TO authenticated;

-- Token rows are created by the OAuth callback edge function (service role).
-- Client INSERT stays allowed only for the initial "not_connected" stub row;
-- token columns are excluded.
REVOKE INSERT ON public.hubspot_connections FROM authenticated;
GRANT INSERT (id, user_id, portal_id, status, connected_at)
  ON public.hubspot_connections TO authenticated;

-- -----------------------------------------------------------------------------
-- 2. Missing DELETE policies (RLS) for user-owned rows
-- -----------------------------------------------------------------------------

-- Disconnect HubSpot: allow a user to remove their own connection row
DROP POLICY IF EXISTS "Users can delete own connection" ON public.hubspot_connections;
CREATE POLICY "Users can delete own connection"
  ON public.hubspot_connections FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

GRANT DELETE ON public.hubspot_connections TO authenticated;

-- Clear activity history: allow a user to delete their own logs
DROP POLICY IF EXISTS "Users can delete own contact logs" ON public.hubspot_contact_logs;
CREATE POLICY "Users can delete own contact logs"
  ON public.hubspot_contact_logs FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- =============================================================================
-- END OF MIGRATION
-- =============================================================================
