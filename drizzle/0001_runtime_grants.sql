-- Grant the runtime role, and the backup role when there is one, the
-- operator names in database settings (docs/deploy.md), set once per database
-- by a superuser before the first migration:
--
--   ALTER DATABASE <database> SET openagency.migrator_role = '<migrator role>';
--   ALTER DATABASE <database> SET openagency.runtime_role = '<runtime role>';
--   ALTER DATABASE <database> SET openagency.backup_role = '<backup role>';  -- optional
--
-- Fails closed when a setting is missing, a named role does not exist, the
-- migrations run as another role than the migrator, or the runtime role is
-- elevated. Roles are created by the operator, not here. Every later migration
-- that adds a table grants it the same way.
DO $$
DECLARE
  migrator_role text := nullif(current_setting('openagency.migrator_role', true), '');
  runtime_role text := nullif(current_setting('openagency.runtime_role', true), '');
  backup_role text := nullif(current_setting('openagency.backup_role', true), '');
  target text;
BEGIN
  IF migrator_role IS NULL THEN
    RAISE EXCEPTION 'database setting openagency.migrator_role is not set'
      USING HINT = 'As a superuser: ALTER DATABASE <database> SET openagency.migrator_role = ''<role>''; see docs/deploy.md';
  END IF;
  IF current_user::text <> migrator_role THEN
    RAISE EXCEPTION 'migrations run as % (openagency.migrator_role), not as %', migrator_role, current_user;
  END IF;
  IF runtime_role IS NULL THEN
    RAISE EXCEPTION 'database setting openagency.runtime_role is not set'
      USING HINT = 'As a superuser: ALTER DATABASE <database> SET openagency.runtime_role = ''<role>''; see docs/deploy.md';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = runtime_role) THEN
    RAISE EXCEPTION 'runtime role % (openagency.runtime_role) does not exist', runtime_role;
  END IF;
  IF backup_role IS NOT NULL AND NOT EXISTS (SELECT FROM pg_roles WHERE rolname = backup_role) THEN
    RAISE EXCEPTION 'backup role % (openagency.backup_role) does not exist', backup_role;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = runtime_role AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb)) THEN
    RAISE EXCEPTION 'runtime role % has elevated attributes', runtime_role;
  END IF;
  IF runtime_role = current_user THEN
    RAISE EXCEPTION 'runtime role must differ from the migrator';
  END IF;

  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', runtime_role);
  FOREACH target IN ARRAY ARRAY['provider_apps', 'channels', 'channel_credentials', 'oauth_states', 'publishing_controls', 'media', 'jobs', 'attempts'] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO %I', target, runtime_role);
  END LOOP;
  -- The event log is append-only for the service.
  EXECUTE format('GRANT SELECT, INSERT ON public.events TO %I', runtime_role);
  EXECUTE format('GRANT USAGE ON SEQUENCE public.events_id_seq TO %I', runtime_role);

  IF backup_role IS NOT NULL THEN
    EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', backup_role);
    EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA public TO %I', backup_role);
    EXECUTE format('GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', backup_role);
  END IF;
END
$$;
