ALTER TABLE "webhook_deliveries" ADD COLUMN "failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "last_http_status" integer;