CREATE TABLE "channel_activity" (
	"channel_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"profile" jsonb,
	"seen_post_ids" text[],
	"checked_at" timestamp with time zone,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_activity_failure_count" CHECK (failure_count >= 0),
	CONSTRAINT "channel_activity_seen_size" CHECK (coalesce(cardinality(seen_post_ids), 0) <= 200)
);
--> statement-breakpoint
ALTER TABLE "webhooks" DROP CONSTRAINT "webhooks_event_types";--> statement-breakpoint
ALTER TABLE "channel_activity" ADD CONSTRAINT "channel_activity_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_activity_organization" ON "channel_activity" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_event_types" CHECK (cardinality(event_types) > 0 and event_types <@ array['post.published', 'post.failed', 'post.metrics.changed', 'channel.metrics.changed', 'comment.created', 'channel.post.created', 'channel.profile.changed', 'channel.status.changed', 'reply.sent', 'reply.failed']::text[]);--> statement-breakpoint
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
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.channel_activity TO %I', runtime_role);
  IF backup_role IS NOT NULL THEN
    EXECUTE format('GRANT SELECT ON public.channel_activity TO %I', backup_role);
  END IF;
END
$$;
