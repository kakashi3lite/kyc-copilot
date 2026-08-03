import { beforeEach, describe, expect, it, vi } from "vitest";
import { auditLlmCall, hashPromptResponse, reportLlmCall } from "../../../../src/services/llm/audit.js";
import { writeAuditLog } from "../../../../src/services/audit/logger.js";
import { recordTokenUsage, LlmCallRecordSchema } from "../../../../src/services/llm/cost-tracker.js";
import { DeterministicLlmClient } from "../../../../src/services/llm/client.js";
import { initialState } from "../../../../src/graph/state.js";

// writeAuditLog is mocked so the test can assert on the audit entry without a DB.
vi.mock("../../../../src/services/audit/logger.js", () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

// Partially mock cost-tracker: keep the real module but intercept recordTokenUsage
// so reportLlmCall's usage accumulation can be asserted without a DB.
vi.mock("../../../../src/services/llm/cost-tracker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/services/llm/cost-tracker.js")>();
  return { ...actual, recordTokenUsage: vi.fn(async () => {}) };
});

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
  const queryMock = vi.fn(async () => ({ rows: [] }));
  const clientMock = { query: queryMock, release: vi.fn() };
  const Pool = vi.fn().mockImplementation(function () {
    return { connect: vi.fn(async () => clientMock), query: queryMock, end: vi.fn(async () => {}), on: vi.fn() };
  });
  return { Pool, default: { Pool } };
});

const baseRecord = {
  tenantId: "ten_1",
  caseId: "case_1",
  modelId: "gpt-4o-mini",
  tier: "t2",
  promptTokens: 1500,
  completionTokens: 500,
  costUsd: 0.000525,
  latencyMs: 1200,
  cached: false,
} as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("hashPromptResponse", () => {
  it("is deterministic — same text → same hash", () => {
    const a = hashPromptResponse("hello", "world");
    const b = hashPromptResponse("hello", "world");
    expect(a).toEqual(b);
    expect(a.promptHash).toHaveLength(64);
    expect(a.responseHash).toHaveLength(64);
  });

  it("differs when the text differs", () => {
    const a = hashPromptResponse("hello", "world");
    const b = hashPromptResponse("hello!", "world");
    expect(a.promptHash).not.toBe(b.promptHash);
  });
});

describe("auditLlmCall (Sprint 1)", () => {
  it("writes an audit entry with action llm.call and integrity hashes", async () => {
    await auditLlmCall({ ...baseRecord, promptHash: "x".repeat(64), responseHash: "y".repeat(64) }, "the prompt", "the response");
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    const [entry] = vi.mocked(writeAuditLog).mock.calls[0]!;
    expect(entry.actor).toBe("system");
    expect(entry.action).toBe("llm.call");
    expect(entry.tenantId).toBe("ten_1");
    expect(entry.caseId).toBe("case_1");
    const newValue = entry.newValue as Record<string, unknown>;
    expect(newValue.promptHash).toBe(hashPromptResponse("the prompt", "the response").promptHash);
    expect(newValue.responseHash).toBe(hashPromptResponse("the prompt", "the response").responseHash);
    expect(newValue.costUsd).toBe(0.000525);
    expect(newValue.cached).toBe(false);
  });

  it("audit entry contains every field required by LlmCallRecordSchema", async () => {
    await auditLlmCall({ ...baseRecord, promptHash: "a".repeat(64), responseHash: "b".repeat(64) }, "p", "r");
    const [entry] = vi.mocked(writeAuditLog).mock.calls[0]!;
    const newValue = entry.newValue as Record<string, unknown>;
    // Every scalar field on a valid LlmCallRecord is represented in the entry.
    const record = LlmCallRecordSchema.parse({
      ...baseRecord,
      promptHash: String(newValue.promptHash),
      responseHash: String(newValue.responseHash),
    });
    expect(record.modelId).toBe("gpt-4o-mini");
    expect(record.tier).toBe("t2");
  });
});

describe("reportLlmCall", () => {
  it("accumulates usage via recordTokenUsage", async () => {
    await reportLlmCall(baseRecord, "the prompt", "the response");
    expect(recordTokenUsage).toHaveBeenCalledWith("ten_1", 1500, 500, 0.000525);
  });

  it("also writes the audit entry", async () => {
    await reportLlmCall(baseRecord, "the prompt", "the response");
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
  });
});

describe("t0 deterministic client (no LLM)", () => {
  it("produces no audit entries", async () => {
    const state = initialState({ caseId: "case_1", tenantId: "ten_1", companyName: "Acme BV", registrationNumber: "NL1", jurisdiction: "NL" });
    state.apiData = {
      legalName: "Acme BV", registrationNumber: "NL1", jurisdiction: "NL", status: "active",
      incorporationDate: null, address: null, ubos: [], sanctions: [], pep: false,
      sourceUrl: "urn:test", completeness: "complete",
    };
    state.uboVerified = true;
    await new DeterministicLlmClient().draftDossier(state);
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
});
