CREATE TABLE "plans" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"cases_per_month" integer NOT NULL,
	"price_monthly_usd" integer NOT NULL,
	"features" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stripe_price_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "stripe_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"tenant_id" text,
	"payload" jsonb NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "stripe_subscription_id" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "stripe_price_id" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "trial_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "subscription_status" text DEFAULT 'inactive' NOT NULL;--> statement-breakpoint
ALTER TABLE "usage" ADD COLUMN "stripe_usage_record_id" text;--> statement-breakpoint
ALTER TABLE "usage" ADD COLUMN "reported_to_stripe_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_login_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "invited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "invite_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deactivated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "reset_token_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "reset_token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stripe_events" ADD CONSTRAINT "stripe_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stripe_events_type_idx" ON "stripe_events" USING btree ("type");--> statement-breakpoint
CREATE INDEX "stripe_events_tenant_idx" ON "stripe_events" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "tenants_subscription_status_idx" ON "tenants" USING btree ("subscription_status");--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_stripe_subscription_unique" ON "tenants" USING btree ("stripe_subscription_id") WHERE "tenants"."stripe_subscription_id" IS NOT NULL;--> statement-breakpoint
INSERT INTO "plans" ("id", "name", "cases_per_month", "price_monthly_usd", "features") VALUES
  ('starter',    'Starter',    50,    9900,  '{"webhooks": false, "rescreen": false, "reports": true, "api_access": true, "team_members": 1}'),
  ('growth',     'Growth',     500,   49900, '{"webhooks": true,  "rescreen": true,  "reports": true, "api_access": true, "team_members": 10}'),
  ('enterprise', 'Enterprise', 99999, 99900, '{"webhooks": true,  "rescreen": true,  "reports": true, "api_access": true, "team_members": 999}')
ON CONFLICT ("id") DO NOTHING;