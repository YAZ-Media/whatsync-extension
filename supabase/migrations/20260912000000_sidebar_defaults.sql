alter table public.hubspot_integration_settings add column if not exists default_lead_status text;
alter table public.hubspot_sidebar_fields add column if not exists sort_order integer not null default 0;
