import { beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresGraphQueryService } from "../../../../src/services/kyc-data/graph-query.js";
import type { ResolvedEntity } from "../../../../src/services/kyc-data/entity-resolver.js";

/**
 * PostgresGraphQueryService unit tests. The pg mock runs in ARRAY row mode
 * (drizzle's node-postgres session maps positionally against the SELECT
 * column list), so rows are returned as arrays in SELECT column order.
 * The mock is stateful: seeded tables drive every query, keyed by the SQL
 * shape + bound params.
 */

type Row = Record<string, unknown>;

const mockTables = vi.hoisted(() => ({
  entities: [] as Row[],
  edges: [] as Row[],
  caseLinks: [] as Row[],
  caseRows: [] as Row[],
}));

const COLUMNS: Record<string, string[]> = {
  graph_entities: ["id", "tenant_id", "canonical_name", "entity_type", "jurisdiction", "registration_number", "source_metadata", "resolution_confidence", "embedding", "is_active", "created_at", "updated_at", "deleted_at"],
  graph_edges: ["id", "tenant_id", "source_entity_id", "target_entity_id", "relationship_type", "edge_metadata", "created_at", "updated_at", "deleted_at"],
  case_entities: ["id", "case_id", "entity_id", "role", "created_at", "updated_at", "deleted_at"],
  cases: ["id", "tenant_id", "company_name_encrypted", "company_name_mask", "registration_number_encrypted", "registration_number_mask", "jurisdiction", "status", "risk_score", "requires_human", "ubo_verified", "browser_failed", "dossier", "graph_state", "completed_at", "created_at", "updated_at", "deleted_at"],
};

vi.mock("ioredis", () => {
  const Redis = vi.fn().mockImplementation(function () {
    return {
      incr: vi.fn(async () => 1),
      expire: vi.fn(async () => 1),
      ping: vi.fn(async () => "PONG"),
      quit: vi.fn(async () => {}),
      on: vi.fn(),
      defineCommand: vi.fn(),
    };
  });
  return { Redis, default: Redis };
});

vi.mock("pg", () => {
  const parseSelect = (sqlText: string): string[] => {
    const m = sqlText.match(/select (.+?) from/i);
    if (!m) return [];
    return m[1]!.split(",")
      .map((c) => c.trim().replace(/^"|"$/g, ""))
      .map((c) => (c.split("::")[0] ?? c).split(".").pop() ?? c)
      .filter((c) => c.length > 0);
  };
  const toArrayRow = (obj: Row | undefined, cols: string[]): unknown[] | null =>
    obj === undefined ? null : cols.map((c) => obj[c] ?? null);

  // drizzle's node-postgres session calls client.query(config, params) — the
  // bound values are the SECOND argument, not a config property.
  const queryMock = vi.fn().mockImplementation(async (config: any, values?: unknown[]) => {
    const sqlText = typeof config === "string" ? config : config.text;
    const params: unknown[] = values ?? [];

    // ── writes ─────────────────────────────────────────────────────────────
    if (/^update "/i.test(sqlText)) {
      const table = sqlText.match(/update "([a-z_]+)"/i)?.[1] ?? "";
      const setPart = sqlText.match(/set (.+?) where/i)?.[1] ?? "";
      const fields: Row = {};
      for (const clause of setPart.split(",")) {
        const m = clause.match(/"([a-z_]+)" = \$(\d+)/);
        if (m) fields[m[1]!] = params[Number(m[2]) - 1];
      }
      const id = String(params[params.length - 1]);
      const rows = table === "graph_entities" ? mockTables.entities : [];
      const target = rows.find((r) => r.id === id);
      if (target) Object.assign(target, fields);
      return { rows: [] };
    }

    if (/^insert into/i.test(sqlText)) {
      const m = sqlText.match(/insert into "([a-z_]+)" \(([^)]+)\) values/i);
      const table = m?.[1] ?? "";
      const cols = (m?.[2] ?? "").split(",").map((c: string) => c.trim().replace(/^"|"$/g, ""));
      const row: Row = {};
      cols.forEach((c: string, i: number) => { row[c] = params[i] ?? null; });
      if (table === "graph_entities") mockTables.entities.push(row);
      if (table === "case_entities") mockTables.caseLinks.push(row);
      if (table === "graph_edges") mockTables.edges.push(row);
      return { rows: [] };
    }

    // ── reads ──────────────────────────────────────────────────────────────
    let fromMatch = sqlText.match(/from "([a-z_]+)"/i);
    const table = fromMatch?.[1] ?? "";
    let cols = parseSelect(sqlText);

    // Handle inner joins: the column list spans both tables. If parseSelect
    // returned empty, try a greedy match that captures everything before FROM
    // including columns from joined tables.
    if (cols.length === 0 && /inner\s+join/i.test(sqlText)) {
      const greedyCols = sqlText.match(/select\s+(.+?)\s+from\s+/is);
      if (greedyCols?.[1]) {
        cols = greedyCols[1]
          .split(",")
          .map((c: string) => c.trim())
          .map((c: string) => c.replace(/^"[a-z_]+"\."/i, "").replace(/^"|"$/g, ""))
          .filter((c: string) => c.length > 0);
      }
    }
    if (cols.length === 0) return { rows: [] };

    if (table === "graph_entities") {
      if (/in \(/i.test(sqlText)) {
        // inArray(graphEntities.id, [...])
        const ids = params.map(String);
        return { rows: mockTables.entities.filter((e) => ids.includes(String(e.id))).map((e) => toArrayRow(e, cols)) };
      }
      // G3: getContext lookup: WHERE tenant_id = $1 AND canonical_name = $2 AND jurisdiction = $3
      if (/"canonical_name"\s*=\s*\$\d+/i.test(sqlText)) {
        const [tenantId, name, jur] = [String(params[0]), String(params[1]), String(params[2])];
        const found = mockTables.entities.find((e) =>
          String(e.tenant_id) === tenantId && e.canonical_name === name && e.jurisdiction === jur
        );
        return { rows: found ? [toArrayRow(found, cols)] : [] };
      }
      // G3: upsert lookup: WHERE tenant_id = $1 AND registration_number = $2 AND jurisdiction = $3
      if (/"registration_number"\s*=\s*\$\d+/i.test(sqlText)) {
        const [tenantId, reg, jur] = [String(params[0]), String(params[1]), String(params[2])];
        const found = mockTables.entities.find((e) =>
          String(e.tenant_id) === tenantId && e.registration_number === reg && e.jurisdiction === jur
        );
        return { rows: found ? [toArrayRow(found, cols)] : [] };
      }
      // Fallback: treat all params as ids (legacy or unknown query shape)
      const ids = params.map(String);
      return { rows: mockTables.entities.filter((e) => ids.includes(String(e.id))).map((e) => toArrayRow(e, cols)) };
    }

    if (table === "graph_edges") {
      // G3: edges now have tenant_id filter. params: [tenantId, sourceId, targetId...]
      // The query is: WHERE tenant_id = $1 AND (source_entity_id = $2 OR target_entity_id = $3)
      const tenantId = String(params[0]);
      const srcOrTgt = params.slice(1).map(String);
      return { rows: mockTables.edges.filter((e) =>
        String(e.tenant_id) === tenantId && (srcOrTgt.includes(String(e.source_entity_id)) || srcOrTgt.includes(String(e.target_entity_id)))
      ).map((e) => toArrayRow(e, cols)) };
    }

    if (table === "case_entities" && /inner\s+join/i.test(sqlText)) {
      // G3: Drizzle innerJoin(case_entities, cases). Simulate by building
      // rows in positional column order: case_entities columns first, then
      // cases columns. Careful: both tables have `id`, `created_at`,
      // `updated_at`, `deleted_at` — we use the right source per half.
      const entityId = String(params[0]);
      const tenantId = String(params[1] ?? "");
      const ceCols = COLUMNS.case_entities!;
      const caCols = COLUMNS.cases!;
      const combinedRows = mockTables.caseLinks
        .filter((c) => String(c.entity_id) === entityId)
        .map((c) => {
          const linkedCase = mockTables.caseRows.find(
            (r) => String(r.id) === String(c.case_id) && String(r.tenant_id) === tenantId
          );
          if (!linkedCase) return null;
          return [...ceCols.map((col: string) => c[col] ?? null), ...caCols.map((col: string) => linkedCase[col] ?? null)];
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);
      return { rows: combinedRows };
    }

    if (table === "cases") {
      const ids = params.map(String);
      return { rows: mockTables.caseRows.filter((c) => ids.includes(String(c.id))).map((c) => toArrayRow(c, cols)) };
    }

    return { rows: [] };
  });

  const clientMock = { query: queryMock, release: vi.fn() };
  const Pool = vi.fn().mockImplementation(function () {
    return { connect: vi.fn(async () => clientMock), query: queryMock, end: vi.fn(async () => {}), on: vi.fn() };
  });
  return { Pool, default: { Pool } };
});

const service = new PostgresGraphQueryService();

function resolvedEntity(overrides: Partial<ResolvedEntity> = {}): ResolvedEntity {
  return {
    canonicalName: "Acme Logistics BV",
    registrationNumber: "NL12345678",
    jurisdiction: "NL",
    sources: [{ sourceName: "opencorporates", name: "Acme Logistics BV", matchConfidence: 1 }],
    confidence: 0.9,
    conflicts: [],
    ...overrides,
  };
}

function entityRow(overrides: Partial<Row> = {}): Row {
  const now = new Date();
  return {
    id: "ent_1",
    tenant_id: "ten_1",
    canonical_name: "Acme Logistics BV",
    entity_type: "company",
    jurisdiction: "NL",
    registration_number: "NL12345678",
    source_metadata: { _sourceCount: 1 },
    resolution_confidence: "1.00",
    embedding: null,
    is_active: true,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTables.entities = [];
  mockTables.edges = [];
  mockTables.caseLinks = [];
  mockTables.caseRows = [];
});

describe("PostgresGraphQueryService.getContext", () => {
  it("returns isNewEntity context when no entity exists", async () => {
    const ctx = await service.getContext("ten_1", "case_1", "Acme Logistics BV", "NL");
    expect(ctx.entityResolution.isNewEntity).toBe(true);
    expect(ctx.relatedEntities).toEqual([]);
    expect(ctx.priorCases).toEqual([]);
    expect(ctx.entityResolution.confidence).toBe(1);
    expect(ctx.entityResolution.mergedFrom).toBe(1);
  });

  it("returns related entities and prior cases for an existing entity", async () => {
    mockTables.entities.push(
      entityRow({ id: "ent_1" }),
      entityRow({ id: "ent_2", canonical_name: "Acme Holdings BV", entity_type: "company", jurisdiction: "NL" }),
    );
    mockTables.edges.push({
      id: "edg_1", tenant_id: "ten_1", source_entity_id: "ent_1", target_entity_id: "ent_2",
      relationship_type: "controls", edge_metadata: {}, created_at: new Date(), updated_at: new Date(), deleted_at: null,
    });
    mockTables.caseLinks.push({
      id: "cel_1", case_id: "case_9", entity_id: "ent_1", role: "subject",
      created_at: new Date(), updated_at: new Date(), deleted_at: null,
    });
    mockTables.caseRows.push({
      id: "case_9", tenant_id: "ten_1", company_name_encrypted: "e", company_name_mask: "Ac**",
      registration_number_encrypted: "e", registration_number_mask: "NL****", jurisdiction: "NL",
      status: "completed", risk_score: "High", requires_human: true, ubo_verified: false, browser_failed: false,
      dossier: "High-risk dossier text", graph_state: {}, completed_at: new Date("2026-08-01T00:00:00Z"),
      created_at: new Date(), updated_at: new Date(), deleted_at: null,
    });

    const ctx = await service.getContext("ten_1", "case_1", "Acme Logistics BV", "NL");
    expect(ctx.entityResolution.isNewEntity).toBe(false);
    expect(ctx.relatedEntities).toHaveLength(1);
    expect(ctx.relatedEntities[0]?.canonicalName).toBe("Acme Holdings BV");
    expect(ctx.relatedEntities[0]?.relationshipType).toBe("controls");
    expect(ctx.priorCases).toHaveLength(1);
    expect(ctx.priorCases[0]?.caseId).toBe("case_9");
    expect(ctx.priorCases[0]?.riskScore).toBe("High");
  });
});

describe("PostgresGraphQueryService.upsertEntity", () => {
  it("inserts a new entity and returns its id", async () => {
    const id = await service.upsertEntity(resolvedEntity(), "ten_1");
    expect(id).toMatch(/^ent_/);
    expect(mockTables.entities).toHaveLength(1);
    expect(mockTables.entities[0]?.canonical_name).toBe("Acme Logistics BV");
  });

  it("updates the entity when new resolution confidence is higher", async () => {
    mockTables.entities.push(entityRow({ resolution_confidence: "0.50" }));
    const id = await service.upsertEntity(resolvedEntity({ confidence: 0.9 }), "ten_1");
    expect(id).toBe("ent_1");
    expect(mockTables.entities[0]?.resolution_confidence).toBe("0.9");
    expect(mockTables.entities[0]?.canonical_name).toBe("Acme Logistics BV");
    expect(mockTables.entities).toHaveLength(1); // no duplicate insert
  });

  it("no-ops when new resolution confidence is lower or equal", async () => {
    mockTables.entities.push(entityRow({ resolution_confidence: "0.95", canonical_name: "Acme Logistics BV" }));
    const id = await service.upsertEntity(resolvedEntity({ confidence: 0.9 }), "ten_1");
    expect(id).toBe("ent_1");
    expect(mockTables.entities[0]?.resolution_confidence).toBe("0.95");
    expect(mockTables.entities).toHaveLength(1);
  });
});

describe("PostgresGraphQueryService.linkCaseToEntity", () => {
  it("inserts a case-entity link", async () => {
    await service.linkCaseToEntity("case_1", "ent_1", "subject");
    expect(mockTables.caseLinks).toHaveLength(1);
    expect(mockTables.caseLinks[0]).toMatchObject({ case_id: "case_1", entity_id: "ent_1", role: "subject" });
  });
});
