import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { caseEntities, graphEdges, graphEntities } from "../../../src/db/schema.js";

/**
 * RAG-Graph schema tests (Sprint 4). Two complementary layers:
 *  1. The Drizzle schema objects define the columns (source of truth for
 *     queries / TS types).
 *  2. The generated migration SQL defines the DB contract — including the
 *     ON DELETE cascade FK behavior, which drizzle's public table type does
 *     not expose at runtime.
 */
const migrationsDir = join(process.cwd(), "src/db/migrations");
const allMigrations = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => readFileSync(join(migrationsDir, f), "utf8"));
const graphMigration = allMigrations
  .find((sql) => sql.includes('CREATE TABLE "graph_entities"'));
const allGraphSql = allMigrations
  .filter((sql) => sql.includes("graph_entities"))
  .join("\n");

describe("RAG-Graph schema — Drizzle columns (Sprint 4)", () => {
  it("graph_entities defines canonical identity columns", () => {
    expect(graphEntities.canonicalName.name).toBe("canonical_name");
    expect(graphEntities.entityType.name).toBe("entity_type");
    expect(graphEntities.jurisdiction.name).toBe("jurisdiction");
    expect(graphEntities.registrationNumber.name).toBe("registration_number");
    expect(graphEntities.sourceMetadata.name).toBe("source_metadata");
    // drizzle reports numeric as driver type "string"
    expect(graphEntities.resolutionConfidence.dataType).toBe("string");
    // drizzle reports jsonb columns with driver dataType "json"
    expect(graphEntities.embedding.dataType).toBe("json");
    expect(graphEntities.isActive.name).toBe("is_active");
  });

  it("graph_edges and case_entities define their link columns", () => {
    expect(graphEdges.sourceEntityId.name).toBe("source_entity_id");
    expect(graphEdges.targetEntityId.name).toBe("target_entity_id");
    expect(graphEdges.relationshipType.name).toBe("relationship_type");
    expect(caseEntities.caseId.name).toBe("case_id");
    expect(caseEntities.entityId.name).toBe("entity_id");
    expect(caseEntities.role.name).toBe("role");
  });
});

describe("RAG-Graph schema — migration contract", () => {
  it("migration creates all three graph tables", () => {
    expect(graphMigration).toBeDefined();
    expect(graphMigration).toContain('CREATE TABLE "graph_entities"');
    expect(graphMigration).toContain('CREATE TABLE "graph_edges"');
    expect(graphMigration).toContain('CREATE TABLE "case_entities"');
  });

  it("graph_edges FKs reference graph_entities with cascade on delete", () => {
    expect(graphMigration).toContain(
      'FOREIGN KEY ("source_entity_id") REFERENCES "public"."graph_entities"("id") ON DELETE cascade',
    );
    expect(graphMigration).toContain(
      'FOREIGN KEY ("target_entity_id") REFERENCES "public"."graph_entities"("id") ON DELETE cascade',
    );
  });

  it("case_entities FKs reference cases + graph_entities with cascade on delete", () => {
    expect(graphMigration).toContain(
      'FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade',
    );
    expect(graphMigration).toContain(
      'FOREIGN KEY ("entity_id") REFERENCES "public"."graph_entities"("id") ON DELETE cascade',
    );
  });

  it("enforces one canonical entity per registration number + jurisdiction + tenant (G3 — tenant isolation)", () => {
    // The initial migration (0003) created the cross-tenant index;
    // migration 0004 drops it and creates the tenant-scoped replacement.
    // The combined SQL must contain the tenant-scoped unique index.
    expect(allGraphSql).toContain('graph_entities_reg_tenant_unique');
    expect(allGraphSql).toContain('"tenant_id"');
    expect(allGraphSql).toContain('WHERE "graph_entities"."registration_number" IS NOT NULL');
  });
});
