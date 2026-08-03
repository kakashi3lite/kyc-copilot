import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkLlmBudget } from "../../../../src/services/llm/budget.js";

/**
 * checkLlmBudget unit tests. The pg mock runs in ARRAY row mode (drizzle's
 * node-postgres session maps positionally), so rows are arrays in SELECT
 * column order:
 *   - tenants:  [llm_budget_usd, active]
 *   - usage:    [COALESCE(SUM(cost_usd), 0)]
 */
const mockState = vi.hoisted(() => ({ tenantFound: true, active: true, budgetUsd: "100.00", spentUsd: 0 }));

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
  const queryMock = vi.fn().mockImplementation(async (config: any) => {
    const sqlText = typeof config === "string" ? config : config.text;
    if (sqlText.includes('from "tenants"')) {
      if (!mockState.tenantFound) return { rows: [] };
      return { rows: [[mockState.budgetUsd, mockState.active]] };
    }
    if (sqlText.includes('from "usage"')) {
      // Single aggregate column: COALESCE(SUM(cost_usd), 0)
      return { rows: [[mockState.spentUsd]] };
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
  mockState.tenantFound = true;
  mockState.active = true;
  mockState.budgetUsd = "100.00";
  mockState.spentUsd = 0;
});

describe("checkLlmBudget (Sprint 2)", () => {
  it("tenant with $0 spent, $100 budget → allowed, no warning", async () => {
    const result = await checkLlmBudget("ten_1");
    expect(result).toEqual({ allowed: true, spentUsd: 0, budgetUsd: 100, remainingUsd: 100, warning: false });
  });

  it("tenant with $80 spent, $100 budget → allowed with warning", async () => {
    mockState.spentUsd = 80;
    const result = await checkLlmBudget("ten_1");
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.warning).toBe(true);
      expect(result.remainingUsd).toBe(20);
    }
  });

  it("tenant with $100 spent, $100 budget → blocked (budget_exceeded)", async () => {
    mockState.spentUsd = 100;
    const result = await checkLlmBudget("ten_1");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("budget_exceeded");
    }
  });

  it("tenant with spend over budget → blocked", async () => {
    mockState.spentUsd = 120;
    const result = await checkLlmBudget("ten_1");
    expect(result.allowed).toBe(false);
  });

  it("tenant not found → blocked (tenant_disabled)", async () => {
    mockState.tenantFound = false;
    const result = await checkLlmBudget("ten_ghost");
    expect(result).toEqual({ allowed: false, spentUsd: 0, budgetUsd: 0, reason: "tenant_disabled" });
  });

  it("disabled tenant → blocked (tenant_disabled)", async () => {
    mockState.active = false;
    const result = await checkLlmBudget("ten_1");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("tenant_disabled");
    }
  });
});
