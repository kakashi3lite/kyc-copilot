CREATE TABLE "case_entities" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"entity_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "graph_edges" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"source_entity_id" text NOT NULL,
	"target_entity_id" text NOT NULL,
	"relationship_type" text NOT NULL,
	"edge_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "graph_entities" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"canonical_name" text NOT NULL,
	"entity_type" text NOT NULL,
	"jurisdiction" varchar(2),
	"registration_number" text,
	"source_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resolution_confidence" numeric(3, 2) DEFAULT '1.00' NOT NULL,
	"embedding" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "case_entities" ADD CONSTRAINT "case_entities_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_entities" ADD CONSTRAINT "case_entities_entity_id_graph_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."graph_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_edges" ADD CONSTRAINT "graph_edges_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_edges" ADD CONSTRAINT "graph_edges_source_entity_id_graph_entities_id_fk" FOREIGN KEY ("source_entity_id") REFERENCES "public"."graph_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_edges" ADD CONSTRAINT "graph_edges_target_entity_id_graph_entities_id_fk" FOREIGN KEY ("target_entity_id") REFERENCES "public"."graph_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_entities" ADD CONSTRAINT "graph_entities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "case_entities_case_idx" ON "case_entities" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "case_entities_entity_idx" ON "case_entities" USING btree ("entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "case_entities_unique" ON "case_entities" USING btree ("case_id","entity_id","role");--> statement-breakpoint
CREATE INDEX "graph_edges_source_idx" ON "graph_edges" USING btree ("source_entity_id");--> statement-breakpoint
CREATE INDEX "graph_edges_target_idx" ON "graph_edges" USING btree ("target_entity_id");--> statement-breakpoint
CREATE INDEX "graph_edges_tenant_idx" ON "graph_edges" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "graph_edges_rel_type_idx" ON "graph_edges" USING btree ("relationship_type");--> statement-breakpoint
CREATE INDEX "graph_entities_tenant_idx" ON "graph_entities" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "graph_entities_type_idx" ON "graph_entities" USING btree ("entity_type");--> statement-breakpoint
CREATE INDEX "graph_entities_name_idx" ON "graph_entities" USING btree ("canonical_name");--> statement-breakpoint
CREATE UNIQUE INDEX "graph_entities_reg_unique" ON "graph_entities" USING btree ("registration_number","jurisdiction") WHERE "graph_entities"."registration_number" IS NOT NULL;