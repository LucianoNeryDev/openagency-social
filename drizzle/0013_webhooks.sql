CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"webhook_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_status" integer,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_state" CHECK (state in ('pending', 'delivered', 'failed')),
	CONSTRAINT "webhook_deliveries_payload_size" CHECK (pg_column_size(payload) <= 65536)
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"url" text NOT NULL,
	"description" text,
	"event_types" text[] NOT NULL,
	"channel_ids" uuid[],
	"status" text DEFAULT 'active' NOT NULL,
	"disabled_reason" text,
	"secret_key_id" text NOT NULL,
	"secret_nonce" "bytea" NOT NULL,
	"secret_ciphertext" "bytea" NOT NULL,
	"previous_secret_key_id" text,
	"previous_secret_nonce" "bytea",
	"previous_secret_ciphertext" "bytea",
	"previous_secret_expires_at" timestamp with time zone,
	"failing_since" timestamp with time zone,
	"last_delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhooks_status" CHECK (status in ('active', 'disabled')),
	CONSTRAINT "webhooks_event_types" CHECK (cardinality(event_types) > 0 and event_types <@ array['post.published', 'post.failed', 'post.metrics.changed', 'channel.metrics.changed', 'comment.created']::text[]),
	CONSTRAINT "webhooks_url" CHECK (url like 'https://%' and char_length(url) <= 2000),
	CONSTRAINT "webhooks_description_length" CHECK (char_length(description) <= 200)
);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due" ON "webhook_deliveries" USING btree ("next_attempt_at") WHERE state = 'pending';--> statement-breakpoint
CREATE INDEX "webhook_deliveries_webhook" ON "webhook_deliveries" USING btree ("webhook_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_created" ON "webhook_deliveries" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "webhooks_organization" ON "webhooks" USING btree ("organization_id");--> statement-breakpoint
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
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.webhooks, public.webhook_deliveries TO %I', runtime_role);
  IF backup_role IS NOT NULL THEN
    EXECUTE format('GRANT SELECT ON public.webhooks, public.webhook_deliveries TO %I', backup_role);
  END IF;
END
$$;
