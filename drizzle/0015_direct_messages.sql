CREATE TABLE "conversation_checks" (
	"channel_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"next_check_at" timestamp with time zone NOT NULL,
	"checked_at" timestamp with time zone,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"backoff_until" timestamp with time zone,
	"rate_limit_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_checks_counts" CHECK (failure_count >= 0 and rate_limit_count >= 0)
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"channel_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"external_id" text NOT NULL,
	"participant_external_id" text,
	"participant_name" text,
	"participant_username" text,
	"updated_time" timestamp with time zone NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"last_message_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_channel_external" UNIQUE("channel_id","external_id"),
	CONSTRAINT "conversations_platform" CHECK (platform in ('messenger', 'instagram'))
);
--> statement-breakpoint
CREATE TABLE "direct_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"channel_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"direction" text NOT NULL,
	"text" text NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "direct_messages_channel_external" UNIQUE("channel_id","external_id"),
	CONSTRAINT "direct_messages_direction" CHECK (direction in ('in', 'out')),
	CONSTRAINT "direct_messages_text_length" CHECK (char_length(text) <= 5000),
	CONSTRAINT "direct_messages_attachments_size" CHECK (pg_column_size(attachments) <= 8192)
);
--> statement-breakpoint
CREATE TABLE "outgoing_message_cancellations" (
	"request_key" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outgoing_message_cancellations_key" CHECK (request_key ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "outgoing_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"channel_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"request_key" text NOT NULL,
	"message_id" text NOT NULL,
	"revision" integer NOT NULL,
	"digest" text NOT NULL,
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
	"error_code" text,
	"permission" text,
	"platform_message_id" text,
	"settled_by" text,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outgoing_messages_request_key" UNIQUE("request_key"),
	CONSTRAINT "outgoing_messages_revision_unique" UNIQUE("organization_id","message_id","revision"),
	CONSTRAINT "outgoing_messages_state" CHECK (state in ('queued', 'sending', 'sent', 'failed', 'uncertain', 'cancelled')),
	CONSTRAINT "outgoing_messages_revision" CHECK (revision > 0),
	CONSTRAINT "outgoing_messages_hashes" CHECK (request_key ~ '^[0-9a-f]{64}$' and digest ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "outgoing_messages_text_length" CHECK (char_length(text) between 1 and 5000),
	CONSTRAINT "outgoing_messages_counts" CHECK (attempt_count >= 0 and reconcile_count >= 0 and reconcile_misses >= 0),
	CONSTRAINT "outgoing_messages_settled_by" CHECK (settled_by is null or settled_by in ('worker', 'reconcile', 'operator')),
	CONSTRAINT "outgoing_messages_resolution" CHECK (resolution is null or resolution in ('sent', 'not_sent'))
);
--> statement-breakpoint
ALTER TABLE "webhooks" DROP CONSTRAINT "webhooks_event_types";--> statement-breakpoint
ALTER TABLE "conversation_checks" ADD CONSTRAINT "conversation_checks_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "direct_messages" ADD CONSTRAINT "direct_messages_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "direct_messages" ADD CONSTRAINT "direct_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outgoing_messages" ADD CONSTRAINT "outgoing_messages_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outgoing_messages" ADD CONSTRAINT "outgoing_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_checks_due" ON "conversation_checks" USING btree ("next_check_at");--> statement-breakpoint
CREATE INDEX "conversation_checks_organization" ON "conversation_checks" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "conversations_inbox" ON "conversations" USING btree ("organization_id","last_message_at","id");--> statement-breakpoint
CREATE INDEX "conversations_last_message" ON "conversations" USING btree ("last_message_at");--> statement-breakpoint
CREATE INDEX "direct_messages_conversation" ON "direct_messages" USING btree ("conversation_id","sent_at","id");--> statement-breakpoint
CREATE INDEX "direct_messages_sent" ON "direct_messages" USING btree ("sent_at");--> statement-breakpoint
CREATE INDEX "outgoing_messages_due" ON "outgoing_messages" USING btree ("not_before") WHERE state = 'queued' or reconciling;--> statement-breakpoint
CREATE INDEX "outgoing_messages_open" ON "outgoing_messages" USING btree ("lease_until") WHERE state = 'sending';--> statement-breakpoint
CREATE INDEX "outgoing_messages_channel_send" ON "outgoing_messages" USING btree ("channel_id","send_at");--> statement-breakpoint
CREATE UNIQUE INDEX "outgoing_messages_channel_platform" ON "outgoing_messages" USING btree ("channel_id","platform_message_id") WHERE platform_message_id is not null;--> statement-breakpoint
CREATE INDEX "outgoing_messages_conversation" ON "outgoing_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "outgoing_messages_organization" ON "outgoing_messages" USING btree ("organization_id","created_at");--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_event_types" CHECK (cardinality(event_types) > 0 and event_types <@ array['post.published', 'post.failed', 'post.metrics.changed', 'channel.metrics.changed', 'comment.created', 'channel.post.created', 'channel.profile.changed', 'channel.status.changed', 'reply.sent', 'reply.failed', 'message.received', 'message.sent', 'message.failed']::text[]);--> statement-breakpoint
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
  FOREACH target IN ARRAY ARRAY['conversation_checks', 'conversations', 'direct_messages', 'outgoing_messages', 'outgoing_message_cancellations'] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO %I', target, runtime_role);
    IF backup_role IS NOT NULL THEN
      EXECUTE format('GRANT SELECT ON public.%I TO %I', target, backup_role);
    END IF;
  END LOOP;
END
$$;
