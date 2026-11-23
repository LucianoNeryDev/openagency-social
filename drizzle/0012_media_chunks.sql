CREATE TABLE "media_chunks" (
	"media_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"data" "bytea" NOT NULL,
	CONSTRAINT "media_chunks_media_id_position_pk" PRIMARY KEY("media_id","position")
);
--> statement-breakpoint
ALTER TABLE "media" ALTER COLUMN "data" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "media_chunks" ADD CONSTRAINT "media_chunks_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Video does not compress; skip the attempt.
ALTER TABLE "media_chunks" ALTER COLUMN "data" SET STORAGE EXTERNAL;--> statement-breakpoint
-- Same role checks as 0001_runtime_grants.sql: the roles come from the
-- openagency.*_role database settings.
DO $$
DECLARE
  migrator_role text := nullif(current_setting('openagency.migrator_role', true), '');
  runtime_role text := nullif(current_setting('openagency.runtime_role', true), '');
  backup_role text := nullif(current_setting('openagency.backup_role', true), '');
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
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.media_chunks TO %I', runtime_role);
  IF backup_role IS NOT NULL THEN
    EXECUTE format('GRANT SELECT ON public.media_chunks TO %I', backup_role);
  END IF;
END
$$;
