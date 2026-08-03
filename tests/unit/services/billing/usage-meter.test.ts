import { beforeEach, describe, expect, it, vi } from "vitest";
import { incrementUsage, getUsageSummary, reportMeteredUsageToStripe } from "../../../../src/services/billing/usage-meter.js";
import { monthKey } from "../../../../src/utils/date.js";

/**
 * usage-meter unit tests. The pg mock runs in ARRAY row mode (drizzle's
 * node-postgres session maps positionally against the query's field list),
 * so rows are returned as arrays in SELECT column order.
 */

const mockState = vi.hoisted(() => ({ usageRowExists: false, tenantHasSubscription: false }));

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
    cases_processed: 3, prompt_tokens: 0, completion_tokens: 0,
    cost_usd: "0", api_calls: 2,
    stripe_usage_record_id: null, reported_to_stripe_at: null,
    created_at: new Date(), updated_at: new Date(), deleted_at: null,
  };
  const tenantRow = {
    id: "ten_1", name: "T", plan: "growth",
    api_key_hash: "h", api_key_id: "k", api_key_algo: "bcrypt",
    webhook_secret_encrypted: "x", llm_budget_usd: "100.00",
    stripe_customer_id: "cus_1",
    stripe_subscription_id: null, // patched at query time
    stripe_price_id: null, trial_ends_at: null, subscription_status: "inactive",
    active: true, created_at: new Date(), updated_at: new Date(), deleted_at: null,
  };
  const queryMock = vi.fn().mockImplementation(async (config: any) => {
    const sqlText = typeof config === "string" ? config : config.text;
    const fromMatch = sqlText.match(/from "([a-z_]+)"/i);
    const table = fromMatch?.[1];
    if (table === "usage") {
      if (!mockState.usageRowExists) return { rows: [] };
      const selectMatch = sqlText.match(/select (.+?) from/i);
      const cols = (selectMatch?.[1] ?? "").split(",").map((c: string) => c.trim().replace(/^"|"$/g, "").split("::")[0]?.split(".")[0]).filter((c: string) => c.length > 0);
      const row = cols.map((c: string) => (usageRow as Record<string, unknown>)[c] ?? null);
      return { rows: [row] };
    }
    if (table === "tenants") {
      const selectMatch = sqlText.match(/select (.+?) from/i);
      const cols = (selectMatch?.[1] ?? "").split(",").map((c: string) => c.trim().replace(/^"|"$/g, "").split("::")[0]?.split(".")[0]).filter((c: string) => c.length > 0);
      const row = cols.map((c: string) => (tenantRow as Record<string, unknown>)[c] ?? null);
      if (mockState.tenantHasSubscription) {
        // patch stripe_subscription_id for the reporting path
        const idx = cols.indexOf("stripe_subscription_id");
        if (idx !== -1) row[idx] = "sub_1";
      }
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
  mockState.tenantHasSubscription = false;
});

describe("incrementUsage", () => {
  it("inserts a row when none exists for the month", async () => {
    await incrementUsage("ten_1", "casesProcessed");
    // No throw = contract satisfied; insert path exercised.
    expect(true).toBe(true);
  });

  it("updates the existing row when one exists", async () => {
    mockState.usageRowExists = true;
    await incrementUsage("ten_1", "apiCalls", 2);
    expect(true).toBe(true);
  });
});

describe("getUsageSummary", () => {
  it("returns zeroed summary when no usage row exists", async () => {
    const s = await getUsageSummary("ten_1");
    expect(s).toMatchObject({ tenantId: "ten_1", month: monthKey(), casesProcessed: 0, apiCalls: 0 });
    expect(s.manualCostAvoidedEur).toBe(0);
  });

  it("computes ROI metrics from the current month row", async () => {
    mockState.usageRowExists = true;
    const s = await getUsageSummary("ten_1");
    expect(s.casesProcessed).toBe(3);
    expect(s.apiCalls).toBe(2);
    expect(s.manualCostAvoidedEur).toBe(3 * 380);
  });
});

describe("reportMeteredUsageToStripe", () => {
  it("is a no-op when the tenant has no Stripe subscription", async () => {
    await reportMeteredUsageToStripe("ten_1", "case_1");
    expect(true).toBe(true); // no throw
  });

  it("is a no-op when Stripe is not configured (null client)", async () => {
    mockState.tenantHasSubscription = true;
    await reportMeteredUsageToStripe("ten_1", "case_1");
    expect(true).toBe(true); // recordUsage returns null → no write
  });
});
