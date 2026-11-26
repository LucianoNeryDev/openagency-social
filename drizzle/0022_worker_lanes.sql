ALTER TABLE "jobs" ADD COLUMN "lane" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_lane" CHECK (lane in ('standard', 'video', 'browser'));--> statement-breakpoint
-- Jobs still to run take their lane now; settled ones keep standard (only the worker reads it).
UPDATE "jobs" SET "lane" = 'browser' FROM "channels"
WHERE "channels"."id" = "jobs"."channel_id" AND "channels"."browser_account_id" IS NOT NULL AND "jobs"."state" IN ('queued', 'running');--> statement-breakpoint
UPDATE "jobs" SET "lane" = 'video'
WHERE "lane" = 'standard' AND "state" IN ('queued', 'running') AND EXISTS (
  SELECT 1 FROM "media" WHERE "media"."organization_id" = "jobs"."organization_id"
    AND "media"."id"::text IN (SELECT jsonb_array_elements_text("jobs"."payload"->'mediaIds')) AND "media"."mime_type" LIKE 'video/%');
