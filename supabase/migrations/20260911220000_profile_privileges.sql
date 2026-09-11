-- Browser clients may edit personal details, never authorization or tenancy.
-- Existing RLS still restricts the permitted columns to the user's own row.
-- Role, status, organization, invitations and 2FA policy belong to server actions.
revoke all on public.user_profiles from anon;
revoke insert, update on public.user_profiles from authenticated;
grant insert (user_id, first_name, last_name, email, company, avatar_url)
  on public.user_profiles to authenticated;
grant update (first_name, last_name, company, avatar_url, extension_version, last_active)
  on public.user_profiles to authenticated;

-- Remove unused anonymous privileges; authenticated token restrictions from
-- the earlier hardening migration are preserved and explicitly enforced here.
revoke all on public.hubspot_connections from anon;
revoke select, insert, update on public.hubspot_connections from authenticated;
grant select (id, user_id, portal_id, expires_at, scopes, status, connected_at, created_at, updated_at)
  on public.hubspot_connections to authenticated;
grant all on public.user_profiles, public.hubspot_connections to service_role;
