CREATE TABLE "answering_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"settings" jsonb NOT NULL,
	"context" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"messages_enabled_at" timestamp with time zone,
	"comments_enabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "answering_settings_version" CHECK (version > 0),
	CONSTRAINT "answering_settings_size" CHECK (pg_column_size(settings) + pg_column_size(context) <= 1048576)
);
--> statement-breakpoint
CREATE TABLE "control_events" (
	"type" text NOT NULL,
	"organization_id" text NOT NULL,
	"event_id" uuid NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"claimed_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "control_events_type_organization_id_pk" PRIMARY KEY("type","organization_id"),
	CONSTRAINT "control_events_type" CHECK (type in ('drafts.available', 'messages.changed', 'replies.changed')),
	CONSTRAINT "control_events_counts" CHECK (attempt_count >= 0 and generation > 0)
);
--> statement-breakpoint
CREATE TABLE "inbound_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"channel_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"conversation_id" uuid,
	"response_id" uuid,
	"inbound_external_id" text NOT NULL,
	"outcome" text NOT NULL,
	"reason" text NOT NULL,
	"decision_model" text,
	"probabilities" jsonb,
	"confidence" double precision,
	"case_id" text,
	"decision_threshold" double precision NOT NULL,
	"none_threshold" double precision NOT NULL,
	"cost" double precision,
	"error_code" text,
	"draft_text" text,
	"draft_digest" text,
	"draft_model" text,
	"draft_language" text,
	"draft_flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"draft_error_code" text,
	"settings_version" integer NOT NULL,
	"superseded_by" uuid,
	"superseded_at" timestamp with time zone,
	"outbox_pending" boolean DEFAULT true NOT NULL,
	"outbox_at" timestamp with time zone NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbound_drafts_kind" CHECK (kind in ('message', 'comment')),
	CONSTRAINT "inbound_drafts_outcome" CHECK (outcome in ('auto', 'review', 'none', 'skipped')),
	CONSTRAINT "inbound_drafts_target" CHECK ((kind = 'message') = (conversation_id is not null) and (kind = 'comment') = (response_id is not null)),
	CONSTRAINT "inbound_drafts_text_length" CHECK (char_length(draft_text) between 1 and 10000),
	CONSTRAINT "inbound_drafts_digest" CHECK ((draft_text is null) = (draft_digest is null) and (draft_digest is null or draft_digest ~ '^[0-9a-f]{64}$'))
);
--> statement-breakpoint
ALTER TABLE "outgoing_messages" ADD COLUMN "approved_via" text DEFAULT 'person' NOT NULL;--> statement-breakpoint
ALTER TABLE "outgoing_messages" ADD COLUMN "draft_id" uuid;--> statement-breakpoint
ALTER TABLE "replies" ADD COLUMN "approved_via" text DEFAULT 'person' NOT NULL;--> statement-breakpoint
ALTER TABLE "replies" ADD COLUMN "draft_id" uuid;--> statement-breakpoint
ALTER TABLE "inbound_drafts" ADD CONSTRAINT "inbound_drafts_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_drafts" ADD CONSTRAINT "inbound_drafts_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_drafts" ADD CONSTRAINT "inbound_drafts_response_id_post_responses_id_fk" FOREIGN KEY ("response_id") REFERENCES "public"."post_responses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "control_events_due" ON "control_events" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_drafts_message" ON "inbound_drafts" USING btree ("conversation_id","inbound_external_id") WHERE kind = 'message';--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_drafts_comment" ON "inbound_drafts" USING btree ("response_id") WHERE kind = 'comment';--> statement-breakpoint
CREATE INDEX "inbound_drafts_outbox" ON "inbound_drafts" USING btree ("outbox_at","id") WHERE outbox_pending;--> statement-breakpoint
CREATE INDEX "inbound_drafts_superseded_by" ON "inbound_drafts" USING btree ("superseded_by") WHERE superseded_by is not null;--> statement-breakpoint
CREATE INDEX "inbound_drafts_channel" ON "inbound_drafts" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "inbound_drafts_created" ON "inbound_drafts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "direct_messages_inbound" ON "direct_messages" USING btree ("organization_id","first_seen_at") WHERE direction = 'in';--> statement-breakpoint
CREATE UNIQUE INDEX "outgoing_messages_draft" ON "outgoing_messages" USING btree ("draft_id") WHERE draft_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "replies_draft" ON "replies" USING btree ("draft_id") WHERE draft_id is not null;--> statement-breakpoint
ALTER TABLE "outgoing_messages" ADD CONSTRAINT "outgoing_messages_approved_via" CHECK (approved_via in ('person', 'automation') and (approved_via = 'automation') = (draft_id is not null));--> statement-breakpoint
ALTER TABLE "replies" ADD CONSTRAINT "replies_approved_via" CHECK (approved_via in ('person', 'automation') and (approved_via = 'automation') = (draft_id is not null));--> statement-breakpoint
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
  FOREACH target IN ARRAY ARRAY['answering_settings', 'inbound_drafts', 'control_events'] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO %I', target, runtime_role);
    IF backup_role IS NOT NULL THEN
      EXECUTE format('GRANT SELECT ON public.%I TO %I', target, backup_role);
    END IF;
  END LOOP;
END
$$;
