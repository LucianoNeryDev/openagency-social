CREATE TABLE "channel_metric_samples" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"collected_at" timestamp with time zone NOT NULL,
	"values" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_metrics" (
	"channel_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"unavailable" text[] DEFAULT '{}'::text[] NOT NULL,
	"collected_at" timestamp with time zone,
	"next_collect_at" timestamp with time zone NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"paused_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_metrics_failure_count" CHECK (failure_count >= 0)
);
--> statement-breakpoint
CREATE TABLE "post_metric_samples" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"channel_id" uuid NOT NULL,
	"collected_at" timestamp with time zone NOT NULL,
	"values" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"channel_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"parent_external_id" text,
	"author_name" text,
	"author_handle" text,
	"text" text NOT NULL,
	"like_count" integer,
	"reply_count" integer,
	"published_at" timestamp with time zone NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"url" text,
	CONSTRAINT "post_responses_channel_external" UNIQUE("channel_id","external_id"),
	CONSTRAINT "post_responses_text_length" CHECK (char_length(text) <= 5000)
);
--> statement-breakpoint
CREATE TABLE "response_checks" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"channel_id" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"next_check_at" timestamp with time zone NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"checked_at" timestamp with time zone,
	"watch_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "response_checks_state" CHECK (state in ('ok', 'unavailable', 'failing', 'not_supported', 'pending')),
	CONSTRAINT "response_checks_failure_count" CHECK (failure_count >= 0)
);
--> statement-breakpoint
ALTER TABLE "channel_metric_samples" ADD CONSTRAINT "channel_metric_samples_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_metrics" ADD CONSTRAINT "channel_metrics_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_metric_samples" ADD CONSTRAINT "post_metric_samples_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_metric_samples" ADD CONSTRAINT "post_metric_samples_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_responses" ADD CONSTRAINT "post_responses_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_responses" ADD CONSTRAINT "post_responses_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "response_checks" ADD CONSTRAINT "response_checks_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "response_checks" ADD CONSTRAINT "response_checks_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_metric_samples_channel" ON "channel_metric_samples" USING btree ("channel_id","collected_at");--> statement-breakpoint
CREATE INDEX "channel_metric_samples_collected" ON "channel_metric_samples" USING btree ("collected_at");--> statement-breakpoint
CREATE INDEX "channel_metrics_due" ON "channel_metrics" USING btree ("next_collect_at");--> statement-breakpoint
CREATE INDEX "channel_metrics_organization" ON "channel_metrics" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "post_metric_samples_job" ON "post_metric_samples" USING btree ("job_id","collected_at");--> statement-breakpoint
CREATE INDEX "post_metric_samples_collected" ON "post_metric_samples" USING btree ("collected_at");--> statement-breakpoint
CREATE INDEX "post_responses_feed" ON "post_responses" USING btree ("organization_id","first_seen_at","id");--> statement-breakpoint
CREATE INDEX "post_responses_job" ON "post_responses" USING btree ("job_id","first_seen_at");--> statement-breakpoint
CREATE INDEX "response_checks_due" ON "response_checks" USING btree ("next_check_at");--> statement-breakpoint
CREATE INDEX "response_checks_watch" ON "response_checks" USING btree ("watch_until") WHERE watch_until is not null;--> statement-breakpoint
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
  FOREACH target IN ARRAY ARRAY['post_metric_samples', 'channel_metrics', 'channel_metric_samples', 'post_responses', 'response_checks'] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO %I', target, runtime_role);
    IF backup_role IS NOT NULL THEN
      EXECUTE format('GRANT SELECT ON public.%I TO %I', target, backup_role);
    END IF;
  END LOOP;
  FOREACH target IN ARRAY ARRAY['post_metric_samples_id_seq', 'channel_metric_samples_id_seq'] LOOP
    EXECUTE format('GRANT USAGE ON SEQUENCE public.%I TO %I', target, runtime_role);
    IF backup_role IS NOT NULL THEN
      EXECUTE format('GRANT SELECT ON SEQUENCE public.%I TO %I', target, backup_role);
    END IF;
  END LOOP;
END
$$;
