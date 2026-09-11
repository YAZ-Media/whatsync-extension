-- Execute after the migration in a transaction; this test changes no records.
do $$
begin
  if has_column_privilege('authenticated','public.user_profiles','role','UPDATE')
    or has_column_privilege('authenticated','public.user_profiles','organization_id','UPDATE')
    or has_column_privilege('authenticated','public.user_profiles','status','UPDATE')
    or has_column_privilege('authenticated','public.user_profiles','role','INSERT')
    or has_column_privilege('authenticated','public.user_profiles','organization_id','INSERT')
    or has_column_privilege('authenticated','public.user_profiles','email','UPDATE') then
    raise exception 'Browser can change protected profile fields';
  end if;
  if not has_column_privilege('authenticated','public.user_profiles','first_name','UPDATE')
    or not has_column_privilege('authenticated','public.user_profiles','user_id','INSERT') then
    raise exception 'Personal profile operations were removed';
  end if;
  if has_column_privilege('authenticated','public.hubspot_connections','access_token','SELECT')
    or has_column_privilege('authenticated','public.hubspot_connections','refresh_token','SELECT')
    or has_column_privilege('anon','public.hubspot_connections','access_token','SELECT') then
    raise exception 'Browser can read OAuth credentials';
  end if;
  if not has_column_privilege('service_role','public.user_profiles','role','UPDATE') then
    raise exception 'Server role management was removed';
  end if;
end $$;
set local role authenticated;
do $$
begin
  begin
    update public.user_profiles set role='Owner' where false;
    raise exception 'Role escalation statement unexpectedly accepted';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.user_profiles set organization_id=null where false;
    raise exception 'Workspace reassignment statement unexpectedly accepted';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
