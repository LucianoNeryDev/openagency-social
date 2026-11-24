ALTER TABLE "channels" DROP CONSTRAINT "channels_platform";--> statement-breakpoint
ALTER TABLE "channels" DROP CONSTRAINT "channels_kind";--> statement-breakpoint
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_platform";--> statement-breakpoint
ALTER TABLE "provider_apps" DROP CONSTRAINT "provider_apps_platform";--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "parent_external_id" text;--> statement-breakpoint
ALTER TABLE "outgoing_messages" ADD COLUMN "delivery_status" text;--> statement-breakpoint
ALTER TABLE "outgoing_messages" ADD COLUMN "delivery_error_code" text;--> statement-breakpoint
ALTER TABLE "outgoing_messages" ADD COLUMN "delivery_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outgoing_messages" ADD COLUMN "reported_message_id" text;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_platform" CHECK (platform in ('meta', 'tiktok', 'youtube', 'instagram', 'x', 'linkedin', 'threads', 'pinterest', 'reddit', 'whatsapp'));--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_kind" CHECK (kind in ('facebook_page', 'instagram_account', 'tiktok_account', 'youtube_channel', 'x_account', 'linkedin_profile', 'linkedin_page', 'threads_account', 'pinterest_account', 'reddit_account', 'whatsapp_number'));--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_platform" CHECK (platform in ('messenger', 'instagram', 'whatsapp'));--> statement-breakpoint
ALTER TABLE "outgoing_messages" ADD CONSTRAINT "outgoing_messages_delivery_status" CHECK (delivery_status is null or delivery_status in ('sent', 'delivered', 'read', 'failed'));--> statement-breakpoint
ALTER TABLE "provider_apps" ADD CONSTRAINT "provider_apps_platform" CHECK (platform in ('meta', 'tiktok', 'youtube', 'instagram', 'x', 'linkedin', 'threads', 'pinterest', 'reddit', 'whatsapp'));