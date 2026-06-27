ALTER TABLE "tenants" ADD COLUMN "api_key_id" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "api_key_algo" text;--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_api_key_id_unique" ON "tenants" USING btree ("api_key_id");