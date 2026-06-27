CREATE TYPE "public"."case_status" AS ENUM('queued', 'processing', 'pending_hitl', 'completed', 'failed', 'archived');--> statement-breakpoint
CREATE TYPE "public"."plan" AS ENUM('starter', 'growth', 'enterprise');--> statement-breakpoint
CREATE TYPE "public"."risk_score" AS ENUM('Low', 'Medium', 'High', 'Pending');--> statement-breakpoint
CREATE TABLE "amld6_articles" (
	"id" text PRIMARY KEY NOT NULL,
	"article" text NOT NULL,
	"title" text NOT NULL,
	"text" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"case_id" text,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"old_value" jsonb,
	"new_value" jsonb,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cases" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"company_name_encrypted" text NOT NULL,
	"company_name_mask" text NOT NULL,
	"registration_number_encrypted" text NOT NULL,
	"registration_number_mask" text NOT NULL,
	"jurisdiction" varchar(2) NOT NULL,
	"status" "case_status" DEFAULT 'queued' NOT NULL,
	"risk_score" "risk_score" DEFAULT 'Pending' NOT NULL,
	"requires_human" boolean DEFAULT false NOT NULL,
	"ubo_verified" boolean DEFAULT false NOT NULL,
	"browser_failed" boolean DEFAULT false NOT NULL,
	"dossier" text DEFAULT '' NOT NULL,
	"graph_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"key" text NOT NULL,
	"source_url_encrypted" text NOT NULL,
	"source_url_mask" text NOT NULL,
	"summary" text NOT NULL,
	"kind" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"previous_hash" text,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "failed_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"reason" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"plan" "plan" DEFAULT 'starter' NOT NULL,
	"api_key_hash" text NOT NULL,
	"webhook_secret_encrypted" text NOT NULL,
	"llm_budget_usd" numeric(10, 2) DEFAULT '100.00' NOT NULL,
	"stripe_customer_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "usage" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"month" varchar(7) NOT NULL,
	"cases_processed" integer DEFAULT 0 NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"api_calls" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'analyst' NOT NULL,
	"refresh_token_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"webhook_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"url_encrypted" text NOT NULL,
	"url_mask" text NOT NULL,
	"secret_encrypted" text NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_tenant_id_idx" ON "audit_logs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "audit_case_id_idx" ON "audit_logs" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "audit_created_at_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "cases_tenant_id_idx" ON "cases" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "cases_status_idx" ON "cases" USING btree ("status");--> statement-breakpoint
CREATE INDEX "cases_risk_score_idx" ON "cases" USING btree ("risk_score");--> statement-breakpoint
CREATE INDEX "cases_created_at_idx" ON "cases" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "evidence_case_id_idx" ON "evidence" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "evidence_tenant_id_idx" ON "evidence" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_case_key_unique" ON "evidence" USING btree ("case_id","key");--> statement-breakpoint
CREATE INDEX "failed_cases_case_id_idx" ON "failed_cases" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "tenants_plan_idx" ON "tenants" USING btree ("plan");--> statement-breakpoint
CREATE INDEX "tenants_created_idx" ON "tenants" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_tenant_month_unique" ON "usage" USING btree ("tenant_id","month");--> statement-breakpoint
CREATE INDEX "usage_tenant_id_idx" ON "usage" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_tenant_idx" ON "users" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "deliveries_tenant_id_idx" ON "webhook_deliveries" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "deliveries_status_idx" ON "webhook_deliveries" USING btree ("status");--> statement-breakpoint
CREATE INDEX "webhooks_tenant_id_idx" ON "webhooks" USING btree ("tenant_id");