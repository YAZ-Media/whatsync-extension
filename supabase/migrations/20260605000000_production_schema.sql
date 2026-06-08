-- =============================================================================
-- WhatSync — Production Database Migration (External Supabase)
-- =============================================================================
--
-- PURPOSE
--   Complete schema for the WhatSync **external** Supabase project that stores:
--   - Auth users (auth.users — created automatically by Supabase Auth)
--   - User profiles, teams, HubSpot OAuth tokens, activity logs
--   - Templates, automations, sidebar config, workspace settings, billing
--
-- WHERE TO RUN
--   Supabase Dashboard → SQL Editor → New query → paste & Run
--   Target: your **External Supabase** project (NOT the Lovable/hosting project)
--
-- PREREQUISITES
--   - Fresh Supabase project (or empty public schema)
--   - Supabase Auth enabled (email/password)
--
-- AFTER RUNNING
--   Configure edge function secrets on the Harmony/Lovable project:
--     EXTERNAL_SUPABASE_URL=<this project's URL>
--     EXTERNAL_SUPABASE_SERVICE_ROLE_KEY=<service role key>
--     HUBSPOT_CLIENT_ID / HUBSPOT_CLIENT_SECRET (OAuth)
--     RESEND_API_KEY / RESEND_FROM (optional — invites & emails)
--
-- SAFE TO RE-RUN
--   Uses IF NOT EXISTS / ON CONFLICT DO NOTHING where possible.
--   On an existing production DB with data, prefer incremental migrations instead.
--
-- Version: 2026-06-05 (matches Harmony commit series through cd09c2a / 0153ae8)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. Extensions
-- -----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- -----------------------------------------------------------------------------
-- 1. Shared trigger helper — auto-update updated_at
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- =============================================================================
-- 2. TABLES
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 2.1 user_profiles
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  first_name text,
  last_name text,
  email text,
  company text,
  role text NOT NULL DEFAULT 'Member'
    CHECK (role IN ('Owner', 'Admin', 'Member', 'Billing', 'Read-only')),
  status text NOT NULL DEFAULT 'Active'
    CHECK (status IN ('Active', 'Pending', 'Suspended')),
  avatar_url text,
  invited_by uuid,
  organization_id uuid,
  enforce_2fa boolean NOT NULL DEFAULT false,
  extension_version text,
  last_active timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_profiles_email
  ON public.user_profiles (email);

CREATE INDEX IF NOT EXISTS idx_user_profiles_organization_id
  ON public.user_profiles (organization_id);

DROP TRIGGER IF EXISTS trg_user_profiles_updated_at ON public.user_profiles;
CREATE TRIGGER trg_user_profiles_updated_at
  BEFORE UPDATE ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 2.2 hubspot_connections (OAuth tokens per user)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.hubspot_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  portal_id text,
  access_token text,
  refresh_token text,
  expires_at timestamptz,
  scopes text[] DEFAULT '{}',
  status text NOT NULL DEFAULT 'not_connected',
  connected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_hubspot_connections_user_id
  ON public.hubspot_connections (user_id);

DROP TRIGGER IF EXISTS trg_hubspot_connections_updated_at ON public.hubspot_connections;
CREATE TRIGGER trg_hubspot_connections_updated_at
  BEFORE UPDATE ON public.hubspot_connections
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 2.3 hubspot_integration_settings
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.hubspot_integration_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  auto_sync_contacts boolean NOT NULL DEFAULT false,
  auto_create_companies boolean NOT NULL DEFAULT false,
  enrich_before_create boolean NOT NULL DEFAULT true,
  attach_message_history boolean NOT NULL DEFAULT false,
  contact_owner_assignment text NOT NULL DEFAULT 'round_robin',
  round_robin_owner_index integer NOT NULL DEFAULT 0,
  default_pipeline_id text,
  default_stage_id text,
  mask_phone_numbers boolean NOT NULL DEFAULT true,
  redact_media_files boolean NOT NULL DEFAULT true,
  data_retention_days integer NOT NULL DEFAULT 90,
  field_mappings jsonb NOT NULL DEFAULT '[
    {"source":"phone","target":"phone","enabled":true},
    {"source":"contact_name","target":"firstname","enabled":true,"splitName":true},
    {"source":"last_message_date","target":"notes_last_contacted","enabled":false},
    {"source":"email","target":"email","enabled":true},
    {"source":"company","target":"company","enabled":true},
    {"source":"job_title","target":"jobtitle","enabled":true}
  ]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_hubspot_integration_settings_user_id
  ON public.hubspot_integration_settings (user_id);

DROP TRIGGER IF EXISTS trg_hubspot_integration_settings_updated_at ON public.hubspot_integration_settings;
CREATE TRIGGER trg_hubspot_integration_settings_updated_at
  BEFORE UPDATE ON public.hubspot_integration_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 2.4 hubspot_contact_logs (activity timeline — extension + dashboard)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.hubspot_contact_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  hubspot_contact_id text,
  phone_number text,
  first_name text,
  last_name text,
  email text,
  company text,
  job_title text,
  activity_type text NOT NULL DEFAULT 'contact_created',
  hubspot_object_id text,
  hubspot_object_type text NOT NULL DEFAULT 'contact',
  title text NOT NULL,
  description text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hubspot_contact_logs_user_id
  ON public.hubspot_contact_logs (user_id);

CREATE INDEX IF NOT EXISTS idx_hubspot_contact_logs_user_created_at
  ON public.hubspot_contact_logs (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_hubspot_contact_logs_activity_type
  ON public.hubspot_contact_logs (user_id, activity_type);

CREATE INDEX IF NOT EXISTS idx_hubspot_contact_logs_hubspot_contact_id
  ON public.hubspot_contact_logs (hubspot_contact_id);

CREATE INDEX IF NOT EXISTS idx_hubspot_contact_logs_created_at
  ON public.hubspot_contact_logs (created_at DESC);

DROP TRIGGER IF EXISTS trg_hubspot_contact_logs_updated_at ON public.hubspot_contact_logs;
CREATE TRIGGER trg_hubspot_contact_logs_updated_at
  BEFORE UPDATE ON public.hubspot_contact_logs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 2.5 whatsync_activity_config (maps activity API to a table — service role only)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.whatsync_activity_config (
  id text PRIMARY KEY DEFAULT 'default',
  table_name text NOT NULL DEFAULT 'hubspot_contact_logs',
  user_column text NOT NULL DEFAULT 'user_id',
  timestamp_column text NOT NULL DEFAULT 'created_at',
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.whatsync_activity_config (id, table_name, user_column, timestamp_column)
VALUES ('default', 'hubspot_contact_logs', 'user_id', 'created_at')
ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 2.6 message_templates
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.message_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  content text NOT NULL,
  category text DEFAULT 'General',
  is_favorite boolean NOT NULL DEFAULT false,
  variables jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_message_templates_user_id
  ON public.message_templates (user_id);

DROP TRIGGER IF EXISTS trg_message_templates_updated_at ON public.message_templates;
CREATE TRIGGER trg_message_templates_updated_at
  BEFORE UPDATE ON public.message_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 2.7 template_categories (global seed data)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.template_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.template_categories (name, description) VALUES
  ('General', 'General purpose templates'),
  ('Sales', 'Sales outreach templates'),
  ('Support', 'Customer support templates'),
  ('Follow-up', 'Follow-up message templates')
ON CONFLICT (name) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 2.8 sidebar_fields (master field catalog for Sidebar Designer)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sidebar_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  field_key text NOT NULL UNIQUE,
  field_label text NOT NULL,
  field_type text NOT NULL DEFAULT 'contact_info'
    CHECK (field_type IN ('contact_info', 'action')),
  icon text,
  is_locked boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.sidebar_fields (field_key, field_label, field_type, sort_order, is_locked) VALUES
  ('firstname_lastname', 'Contact Name', 'contact_info', 1, true),
  ('phone', 'Phone Number', 'contact_info', 2, true),
  ('email', 'Email', 'contact_info', 3, false),
  ('company', 'Company', 'contact_info', 4, false),
  ('jobtitle', 'Job Title', 'contact_info', 5, false),
  ('hubspot_owner_id', 'Contact Owner', 'contact_info', 6, false),
  ('lifecyclestage', 'Lifecycle Stage', 'contact_info', 7, false),
  ('hs_lead_status', 'Lead Status', 'contact_info', 8, false),
  ('createdate', 'Create Date', 'contact_info', 9, false),
  ('notes_last_updated', 'Last Activity Date', 'contact_info', 10, false),
  ('send_template', 'Send Template', 'action', 20, false),
  ('add_note', 'Add Note', 'action', 21, false),
  ('create_task', 'Create Task', 'action', 22, false),
  ('create_deal', 'Create Deal', 'action', 23, false),
  ('create_ticket', 'Create Ticket', 'action', 24, false),
  ('view_in_hubspot', 'View in HubSpot', 'action', 25, false)
ON CONFLICT (field_key) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 2.9 hubspot_sidebar_fields (per-user sidebar preferences)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.hubspot_sidebar_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  field_key text NOT NULL,
  field_type text NOT NULL DEFAULT 'contact_info',
  is_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, field_key)
);

CREATE INDEX IF NOT EXISTS idx_hubspot_sidebar_fields_user_id
  ON public.hubspot_sidebar_fields (user_id);

DROP TRIGGER IF EXISTS trg_hubspot_sidebar_fields_updated_at ON public.hubspot_sidebar_fields;
CREATE TRIGGER trg_hubspot_sidebar_fields_updated_at
  BEFORE UPDATE ON public.hubspot_sidebar_fields
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 2.10 automations
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.automations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  trigger_type text NOT NULL,
  trigger_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  action_type text NOT NULL,
  action_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_automations_user_id
  ON public.automations (user_id);

DROP TRIGGER IF EXISTS trg_automations_updated_at ON public.automations;
CREATE TRIGGER trg_automations_updated_at
  BEFORE UPDATE ON public.automations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 2.11 workspace_settings
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.workspace_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  workspace_name text,
  timezone text NOT NULL DEFAULT 'America/New_York',
  region text NOT NULL DEFAULT 'US',
  retention_days integer NOT NULL DEFAULT 365,
  mask_phone boolean NOT NULL DEFAULT true,
  mask_media boolean NOT NULL DEFAULT false,
  allowed_properties jsonb NOT NULL DEFAULT '["firstname_lastname","phone","email","company","jobtitle","lifecyclestage","hs_lead_status"]'::jsonb,
  weekly_digest boolean NOT NULL DEFAULT true,
  failure_alerts boolean NOT NULL DEFAULT true,
  team_activity boolean NOT NULL DEFAULT false,
  last_weekly_digest_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_workspace_settings_updated_at ON public.workspace_settings;
CREATE TRIGGER trg_workspace_settings_updated_at
  BEFORE UPDATE ON public.workspace_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 2.12 subscriptions (billing)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  plan_name text NOT NULL DEFAULT 'Free',
  price_monthly numeric(10, 2) DEFAULT 0,
  status text NOT NULL DEFAULT 'active',
  max_contacts integer DEFAULT 500,
  max_api_calls integer DEFAULT 10000,
  max_team_members integer DEFAULT 1,
  max_custom_fields integer DEFAULT 5,
  max_templates integer DEFAULT 10,
  max_automations integer DEFAULT 0,
  trial_ends_at timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id
  ON public.subscriptions (user_id);

DROP TRIGGER IF EXISTS trg_subscriptions_updated_at ON public.subscriptions;
CREATE TRIGGER trg_subscriptions_updated_at
  BEFORE UPDATE ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 2.13 usage_tracking
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.usage_tracking (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  action_type text NOT NULL,
  count integer NOT NULL DEFAULT 1,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_usage_tracking_user_id
  ON public.usage_tracking (user_id);

-- -----------------------------------------------------------------------------
-- 2.14 invoices
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  invoice_number text,
  plan_name text,
  amount numeric(10, 2) NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  status text NOT NULL DEFAULT 'pending',
  description text,
  period_start timestamptz,
  period_end timestamptz,
  invoice_date timestamptz DEFAULT now(),
  due_date timestamptz,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invoices_user_id
  ON public.invoices (user_id);

-- -----------------------------------------------------------------------------
-- 2.15 payment_methods
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payment_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  card_brand text,
  last_four text,
  exp_month integer,
  exp_year integer,
  cardholder_name text,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_methods_user_id
  ON public.payment_methods (user_id);

-- =============================================================================
-- 3. ROW LEVEL SECURITY (RLS)
-- =============================================================================
-- Note: Edge functions use the service role key and bypass RLS.
-- Client/extension JWT access is scoped to auth.uid() = user_id.

ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hubspot_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hubspot_integration_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hubspot_contact_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsync_activity_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.template_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sidebar_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hubspot_sidebar_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_tracking ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_methods ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- 3.1 user_profiles policies
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can read own profile" ON public.user_profiles;
CREATE POLICY "Users can read own profile"
  ON public.user_profiles FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own profile" ON public.user_profiles;
CREATE POLICY "Users can update own profile"
  ON public.user_profiles FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own profile" ON public.user_profiles;
CREATE POLICY "Users can insert own profile"
  ON public.user_profiles FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- -----------------------------------------------------------------------------
-- 3.2 hubspot_connections policies
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can read own connection" ON public.hubspot_connections;
CREATE POLICY "Users can read own connection"
  ON public.hubspot_connections FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can upsert own connection" ON public.hubspot_connections;
CREATE POLICY "Users can upsert own connection"
  ON public.hubspot_connections FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own connection" ON public.hubspot_connections;
CREATE POLICY "Users can update own connection"
  ON public.hubspot_connections FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- -----------------------------------------------------------------------------
-- 3.3 hubspot_integration_settings policies
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can manage own integration settings" ON public.hubspot_integration_settings;
CREATE POLICY "Users can manage own integration settings"
  ON public.hubspot_integration_settings FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- -----------------------------------------------------------------------------
-- 3.4 hubspot_contact_logs policies
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can read own contact logs" ON public.hubspot_contact_logs;
CREATE POLICY "Users can read own contact logs"
  ON public.hubspot_contact_logs FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own contact logs" ON public.hubspot_contact_logs;
CREATE POLICY "Users can insert own contact logs"
  ON public.hubspot_contact_logs FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- -----------------------------------------------------------------------------
-- 3.5 whatsync_activity_config — no client policies (service role only)
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- 3.6 message_templates policies
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can manage own templates" ON public.message_templates;
CREATE POLICY "Users can manage own templates"
  ON public.message_templates FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- -----------------------------------------------------------------------------
-- 3.7 template_categories — read-only for all authenticated users
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Anyone can read categories" ON public.template_categories;
CREATE POLICY "Anyone can read categories"
  ON public.template_categories FOR SELECT
  TO authenticated
  USING (true);

-- -----------------------------------------------------------------------------
-- 3.8 sidebar_fields — read-only master catalog
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Anyone can read sidebar fields" ON public.sidebar_fields;
CREATE POLICY "Anyone can read sidebar fields"
  ON public.sidebar_fields FOR SELECT
  TO authenticated
  USING (true);

-- -----------------------------------------------------------------------------
-- 3.9 hubspot_sidebar_fields policies
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can manage own sidebar fields" ON public.hubspot_sidebar_fields;
CREATE POLICY "Users can manage own sidebar fields"
  ON public.hubspot_sidebar_fields FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- -----------------------------------------------------------------------------
-- 3.10 automations policies
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can manage own automations" ON public.automations;
CREATE POLICY "Users can manage own automations"
  ON public.automations FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- -----------------------------------------------------------------------------
-- 3.11 workspace_settings policies
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can manage own workspace settings" ON public.workspace_settings;
CREATE POLICY "Users can manage own workspace settings"
  ON public.workspace_settings FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- -----------------------------------------------------------------------------
-- 3.12 billing policies
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can read own subscription" ON public.subscriptions;
CREATE POLICY "Users can read own subscription"
  ON public.subscriptions FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can read own usage" ON public.usage_tracking;
CREATE POLICY "Users can read own usage"
  ON public.usage_tracking FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can read own invoices" ON public.invoices;
CREATE POLICY "Users can read own invoices"
  ON public.invoices FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can manage own payment methods" ON public.payment_methods;
CREATE POLICY "Users can manage own payment methods"
  ON public.payment_methods FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- =============================================================================
-- 4. REALTIME (optional — sidebar preference updates in extension)
-- =============================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'hubspot_sidebar_fields'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.hubspot_sidebar_fields;
  END IF;
END $$;

-- =============================================================================
-- 5. GRANTS (Supabase default + explicit authenticated access)
-- =============================================================================
GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;

GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;

GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO postgres, service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- =============================================================================
-- 6. POST-MIGRATION VERIFICATION (run manually — results should match)
-- =============================================================================
-- SELECT table_name
-- FROM information_schema.tables
-- WHERE table_schema = 'public'
-- ORDER BY table_name;
--
-- Expected tables (15):
--   automations, hubspot_connections, hubspot_contact_logs,
--   hubspot_integration_settings, hubspot_sidebar_fields, invoices,
--   message_templates, payment_methods, sidebar_fields, subscriptions,
--   template_categories, usage_tracking, user_profiles, whatsync_activity_config,
--   workspace_settings
--
-- SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename;
--
-- =============================================================================
-- END OF MIGRATION
-- =============================================================================
