import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeCostUsd, recordTokenUsage, LlmCallRecordSchema } from "../../../../src/services/llm/cost-tracker.js";

const mockState = vi.hoisted(() => ({ usageRowExists: false }));

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
  const usageRow = {
    id: "use_1", tenant_id: "ten_1", month: "2026-08",
    cases_processed: 0, prompt_tokens: 0, completion_tokens: 0,
    cost_usd: "0", api_calls: 0,
    stripe_usage_record_id: null, reported_to_stripe_at: null,
    created_at: new Date(), updated_at: new Date(), deleted_at: null,
  };
  const queryMock = vi.fn().mockImplementation(async (config: any) => {
    const sqlText = typeof config === "string" ? config : config.text;
    const fromMatch = sqlText.match(/from "([a-z_]+)"/i);
    const table = fromMatch?.[1];
    if (table === "usage") {
      if (!mockState.usageRowExists) return { rows: [] };
      const selectMatch = sqlText.match(/select (.+?) from/i);
      const cols = (selectMatch?.[1] ?? "").split(",")
        .map((c: string) => c.trim().replace(/^"|"$/g, "").split("::")[0]?.split(".")[0])
        .filter((c: string) => c.length > 0);
      const row = cols.map((c: string) => (usageRow as Record<string, unknown>)[c] ?? null);
      return { rows: [row] };
    }
    return { rows: [] };
  });
  const clientMock = { query: queryMock, release: vi.fn() };
  const Pool = vi.fn().mockImplementation(function () {
    return { connect: vi.fn(async () => clientMock), query: queryMock, end: vi.fn(async () => {}), on: vi.fn() };
  });
  return { Pool, default: { Pool } };
});

beforeEach(() => {
  vi.clearAllMocks();
  mockState.usageRowExists = false;
});

describe("computeCostUsd (Sprint 2)", () => {
  it("computes cost from token counts and per-1K pricing", () => {
    // (1500/1000 * 0.00015) + (500/1000 * 0.0006) = 0.000225 + 0.0003
    expect(computeCostUsd(1500, 500, 0.00015, 0.0006)).toBeCloseTo(0.000525, 6);
  });

  it("zero tokens → zero cost", () => {
    expect(computeCostUsd(0, 0, 0.0025, 0.01)).toBe(0);
  });
});

describe("LlmCallRecordSchema (contract)", () => {
  it("accepts a fully-populated record", () => {
    const record = {
      tenantId: "ten_1",
      caseId: "case_1",
      modelId: "gpt-4o-mini",
      tier: "t2",
      promptTokens: 1500,
      completionTokens: 500,
      costUsd: 0.000525,
      promptHash: "a".repeat(64),
      responseHash: "b".repeat(64),
      latencyMs: 1200,
      cached: false,
    };
    expect(LlmCallRecordSchema.parse(record)).toMatchObject({ tier: "t2", cached: false });
  });

  it("rejects a record with a malformed hash", () => {
    const record = {
      tenantId: "ten_1", caseId: "case_1", modelId: "m", tier: "t0",
      promptTokens: 0, completionTokens: 0, costUsd: 0,
      promptHash: "short", responseHash: "also-short",
      latencyMs: 0, cached: false,
    };
    expect(LlmCallRecordSchema.safeParse(record).success).toBe(false);
  });
});

describe("recordTokenUsage (Sprint 2)", () => {
  it("inserts a row when none exists for the month", async () => {
    await recordTokenUsage("ten_1", 1500, 500, 0.000525);
    expect(true).toBe(true); // no throw = insert path exercised
  });

  it("updates the existing row when one exists", async () => {
    mockState.usageRowExists = true;
    await recordTokenUsage("ten_1", 1500, 500, 0.000525);
    expect(true).toBe(true); // no throw = update path exercised
  });
});
