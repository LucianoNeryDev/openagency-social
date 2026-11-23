CREATE TABLE "replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"channel_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"request_key" text NOT NULL,
	"reply_id" text NOT NULL,
	"revision" integer NOT NULL,
	"digest" text NOT NULL,
	"parent_external_id" text NOT NULL,
	"target_external_id" text NOT NULL,
	"text" text NOT NULL,
	"approved_by_user_id" text NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	"send_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"attempted_at" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"reconciling" boolean DEFAULT false NOT NULL,
	"reconcile_count" integer DEFAULT 0 NOT NULL,
	"reconcile_misses" integer DEFAULT 0 NOT NULL,
	"resolution" text,
	"target_resolved" boolean DEFAULT true NOT NULL,
	"error_code" text,
	"permission" text,
	"platform_reply_id" text,
	"url" text,
	"settled_by" text,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "replies_request_key" UNIQUE("request_key"),
	CONSTRAINT "replies_revision_unique" UNIQUE("organization_id","reply_id","revision"),
	CONSTRAINT "replies_state" CHECK (state in ('queued', 'sending', 'sent', 'failed', 'uncertain', 'cancelled')),
	CONSTRAINT "replies_revision" CHECK (revision > 0),
	CONSTRAINT "replies_hashes" CHECK (request_key ~ '^[0-9a-f]{64}$' and digest ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "replies_text_length" CHECK (char_length(text) between 1 and 10000),
	CONSTRAINT "replies_counts" CHECK (attempt_count >= 0 and reconcile_count >= 0 and reconcile_misses >= 0),
	CONSTRAINT "replies_settled_by" CHECK (settled_by is null or settled_by in ('worker', 'reconcile', 'operator')),
	CONSTRAINT "replies_resolution" CHECK (resolution is null or resolution in ('sent', 'not_sent'))
);
--> statement-breakpoint
CREATE TABLE "reply_cancellations" (
	"request_key" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reply_cancellations_key" CHECK (request_key ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "granted_scopes" text[];--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "refused_scopes" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "post_responses" ADD COLUMN "from_channel" boolean;--> statement-breakpoint
ALTER TABLE "replies" ADD CONSTRAINT "replies_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replies" ADD CONSTRAINT "replies_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "replies_due" ON "replies" USING btree ("not_before") WHERE state = 'queued' or reconciling;--> statement-breakpoint
CREATE INDEX "replies_open" ON "replies" USING btree ("lease_until") WHERE state = 'sending';--> statement-breakpoint
CREATE INDEX "replies_channel_send" ON "replies" USING btree ("channel_id","send_at");--> statement-breakpoint
CREATE UNIQUE INDEX "replies_channel_platform" ON "replies" USING btree ("channel_id","platform_reply_id") WHERE platform_reply_id is not null;--> statement-breakpoint
CREATE INDEX "replies_channel_target" ON "replies" USING btree ("channel_id","target_external_id");--> statement-breakpoint
CREATE INDEX "replies_job" ON "replies" USING btree ("job_id");--> statement-breakpoint
-- Responses stored before this migration do not say whether the brand wrote them
-- (from_channel null, so no reply is offered under them): every post still being
-- read is read again on the collectors' next passes, which fills it in.
UPDATE "response_checks" SET "next_check_at" = now() WHERE "state" IN ('ok', 'pending') AND "next_check_at" > now();--> statement-breakpoint
-- Same role checks as 0001_runtime_grants.sql: the roles come from the
-- openagency.*_role database settings.
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
  FOREACH target IN ARRAY ARRAY['replies', 'reply_cancellations'] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO %I', target, runtime_role);
    IF backup_role IS NOT NULL THEN
      EXECUTE format('GRANT SELECT ON public.%I TO %I', target, backup_role);
    END IF;
  END LOOP;
END
$$;
