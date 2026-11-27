CREATE TABLE "learned_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"channel_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"fingerprint" text NOT NULL,
	"inbound_text" text NOT NULL,
	"normalized_text" text NOT NULL,
	"inbound_at" timestamp with time zone NOT NULL,
	"reply_text" text NOT NULL,
	"language" text,
	"source_draft_id" uuid,
	"edited" boolean NOT NULL,
	"addresses_person" boolean DEFAULT false NOT NULL,
	"approved_by_user_id" text NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learned_answers_scope_fingerprint" UNIQUE("channel_id","kind","fingerprint"),
	CONSTRAINT "learned_answers_kind" CHECK (kind in ('message', 'comment')),
	CONSTRAINT "learned_answers_fingerprint" CHECK (fingerprint ~ '^[0-9a-f]{32}$'),
	CONSTRAINT "learned_answers_text_length" CHECK (char_length(inbound_text) between 1 and 5000 and char_length(normalized_text) between 1 and 2000
    and char_length(reply_text) between 1 and 10000),
	CONSTRAINT "learned_answers_uses" CHECK (uses >= 0)
);
--> statement-breakpoint
ALTER TABLE "inbound_drafts" ADD COLUMN "learned_answer_id" uuid;--> statement-breakpoint
ALTER TABLE "inbound_drafts" ADD COLUMN "learned_similarity" double precision;--> statement-breakpoint
ALTER TABLE "learned_answers" ADD CONSTRAINT "learned_answers_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "learned_answers_scope" ON "learned_answers" USING btree ("channel_id","kind","approved_at");--> statement-breakpoint
CREATE INDEX "learned_answers_organization" ON "learned_answers" USING btree ("organization_id","approved_at","id");--> statement-breakpoint
CREATE INDEX "learned_answers_inbound" ON "learned_answers" USING btree ("inbound_at");--> statement-breakpoint
ALTER TABLE "inbound_drafts" ADD CONSTRAINT "inbound_drafts_learned" CHECK ((learned_answer_id is null) = (learned_similarity is null) and learned_similarity between 0 and 1);--> statement-breakpoint
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
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.learned_answers TO %I', runtime_role);
  IF backup_role IS NOT NULL THEN
    EXECUTE format('GRANT SELECT ON public.learned_answers TO %I', backup_role);
  END IF;
END
$$;
