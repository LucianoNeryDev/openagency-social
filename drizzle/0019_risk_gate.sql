ALTER TABLE "inbound_drafts" ADD COLUMN "risk_level" text;--> statement-breakpoint
ALTER TABLE "inbound_drafts" ADD COLUMN "risk_score" integer;--> statement-breakpoint
ALTER TABLE "inbound_drafts" ADD COLUMN "risk_probabilities" jsonb;--> statement-breakpoint
ALTER TABLE "inbound_drafts" ADD COLUMN "risk_confidence" double precision;--> statement-breakpoint
ALTER TABLE "inbound_drafts" ADD COLUMN "risk_threshold" integer;--> statement-breakpoint
ALTER TABLE "inbound_drafts" ADD CONSTRAINT "inbound_drafts_risk_level" CHECK (risk_level in ('low', 'medium', 'high'));--> statement-breakpoint
ALTER TABLE "inbound_drafts" ADD CONSTRAINT "inbound_drafts_risk" CHECK ((risk_level is null) = (risk_score is null) and (risk_level is null) = (risk_probabilities is null)
    and (risk_level is null) = (risk_confidence is null) and risk_score between 0 and 100 and risk_threshold between 0 and 100);