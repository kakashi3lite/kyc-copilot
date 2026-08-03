import { beforeEach, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";
import { createApp } from "../../../src/api/index.js";
import { env } from "../../../src/config/env.js";

/**
 * API contract tests for the Business MVP surface (Phase G.2):
 * billing, usage history, team/users, plan-gate (402), and report verify.
 * The pg/ioredis/bullmq layers are mocked; the Hono app + middleware +
 * route logic run for real.
 */

// Mutable mock state shared with the vi.mock factories below (vi.hoisted is
// hoisted above the vi.mock calls, so the factories can reference it).
const mockState = vi.hoisted(() => ({ usageCases: 10, usageMonths: 1 }));
const testApiKey = "kc_live_test_key";

vi.mock("bcrypt", () => {
  const compare = vi.fn(async (data: string, encrypted: string) => data === "kc_live_test_key" && encrypted === "mocked_hash");
  const hash = vi.fn(async () => "mocked_hash");
  const hashSync = vi.fn(() => "mocked_hash");
  return { compare, hash, hashSync, default: { compare, hash, hashSync } };
});

vi.mock("bullmq", () => {
  const Queue = vi.fn().mockImplementation(function () { return { add: vi.fn(), close: vi.fn() }; });
  const Worker = vi.fn().mockImplementation(function () { return { close: vi.fn(), on: vi.fn() }; });
  return { Queue, Worker };
});

vi.mock("ioredis", () => {
  const Redis = vi.fn().mockImplementation(function () {
    const instance: Record<string, unknown> = {
      incr: vi.fn(async () => 1),
      expire: vi.fn(async () => 1),
      ping: vi.fn(async () => "PONG"),
      quit: vi.fn(async () => {}),
      on: vi.fn(),
    };
    instance["defineCommand"] = vi.fn((_n: string, _o: unknown) => {
      instance["rateLimitAtomic"] = vi.fn(async (_k: string, limit: number, _t: number) => [1, limit, limit - 1, 60]);
    });
    return instance;
  });
  return { Redis, default: Redis };
});

vi.mock("pg", () => {
  // drizzle's node-postgres session runs queries in ARRAY row mode
  // (rowMode: "array") and maps results positionally against the query's
  // field list. To honor that, we parse the SELECT column list out of the
  // generated SQL and return the row as an array in that exact order.
  const tables: Record<string, Record<string, unknown>> = {
    tenants: {
      id: "ten_test_123", name: "Contract Test", plan: "growth",
      api_key_hash: "mocked_hash", api_key_id: "mocked_lookup_id", api_key_algo: "bcrypt",
      webhook_secret_encrypted: "x", llm_budget_usd: "100.00",
      stripe_customer_id: null, stripe_subscription_id: null, stripe_price_id: null,
      trial_ends_at: null, subscription_status: "inactive",
      active: true, created_at: new Date(), updated_at: new Date(), deleted_at: null,
    },
    plans: {
      id: "growth", name: "Growth", cases_per_month: 500, price_monthly_usd: 49900,
      features: {}, stripe_price_id: null,
      created_at: new Date(), updated_at: new Date(), deleted_at: null,
    },
    usage: {
      id: "use_1", tenant_id: "ten_test_123", month: "2026-08",
      cases_processed: mockState.usageCases, prompt_tokens: 0, completion_tokens: 0,
      cost_usd: "0", api_calls: 3,
      stripe_usage_record_id: null, reported_to_stripe_at: null,
      created_at: new Date(), updated_at: new Date(), deleted_at: null,
    },
    users: {
      id: "usr_1", tenant_id: "ten_test_123", email: "admin@contract.test",
      password_hash: "h", role: "admin", refresh_token_hash: null, name: null,
      last_login_at: new Date(), invited_at: null, invite_accepted_at: null,
      deactivated_at: null, reset_token_hash: null, reset_token_expires_at: null,
      created_at: new Date(), updated_at: new Date(), deleted_at: null,
    },
  };

  const queryMock = vi.fn().mockImplementation(async (config: any) => {
    const sqlText = typeof config === "string" ? config : config.text;
    const isArrayMode = typeof config === "object" && config.rowMode === "array";

    // Strip trailing " where ..." / " order by ..." / " limit ..." clauses so
    // the table name + select list are cleanly parseable.
    const fromMatch = sqlText.match(/from "([a-z_]+)"/i);
    const tableName = fromMatch?.[1];
    if (tableName === undefined || tables[tableName] === undefined) {
      return { rows: [] };
    }
    // Patch the usage row's quota counter at QUERY time (the static table
    // map above is built once at mock init).
    let rowObj: Record<string, unknown> | undefined = tables[tableName];
    if (tableName === "usage" && rowObj !== undefined) {
      rowObj = { ...rowObj, cases_processed: mockState.usageCases };
    }
    if (rowObj === undefined) return { rows: [] };

    // Multiple usage rows simulate real history (GET /tenants/:id/usage).
    const rowCount = tableName === "usage" ? mockState.usageMonths : 1;
    const rows = Array.from({ length: rowCount }, () => {
      if (!isArrayMode) return rowObj;
      const selectMatch = sqlText.match(/select (.+?) from/i);
      const cols = (selectMatch?.[1] ?? "")
        .split(",")
        .map((c: string) => c.trim().replace(/^"|"$/g, "").split("::")[0]?.split(".")[0])
        .filter((c: string) => c.length > 0 && !c.includes("count("));
      return cols.map((c: string) => rowObj[c] ?? null);
    });
    return { rows };
  });

  const clientMock = { query: queryMock, release: vi.fn() };
  const Pool = vi.fn().mockImplementation(function () {
    return { connect: vi.fn(async () => clientMock), query: queryMock, end: vi.fn(async () => {}), on: vi.fn() };
  });
  return { Pool, default: { Pool } };
});

beforeEach(() => {
  vi.clearAllMocks();
  mockState.usageCases = 10;
  mockState.usageMonths = 1;
});

const headers = { Authorization: `Bearer ${testApiKey}` };

/** Admin JWT — /users and /tenants routes require role === "admin". */
function adminHeaders(): { Authorization: string } {
  const token = jwt.sign(
    { sub: "usr_1", tenantId: "ten_test_123", role: "admin", type: "access", email: "admin@contract.test" },
    env.JWT_SECRET,
    { expiresIn: "15m" },
  );
  return { Authorization: `Bearer ${token}` };
}

describe("GET /billing — contract shape", () => {
  it("returns plan, subscription status, usage, and invoices array", async () => {
    const app = createApp();
    const res = await app.request("/billing", { headers });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.plan).toMatchObject({ id: "growth", casesPerMonth: 500, priceMonthlyUsd: 49900 });
    expect(typeof body.subscriptionStatus).toBe("string");
    expect(body.currentUsage).toMatchObject({ casesProcessed: 10, apiCalls: 3 });
    expect(Array.isArray(body.invoices)).toBe(true);
    expect(body.upgradeUrl === null || typeof body.upgradeUrl === "string").toBe(true);
  });
});

describe("GET /usage — 6-month history contract", () => {
  it("returns exactly 6 months with zero-filled gaps", async () => {
    const app = createApp();
    const res = await app.request("/usage", { headers });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sixMonthHistory).toHaveLength(6);
    expect(body.sixMonthHistory[0]).toMatchObject({ month: expect.any(String), casesProcessed: expect.any(Number), apiCalls: expect.any(Number), costUsd: expect.any(Number) });
  });
});

describe("GET /users — team contract", () => {
  it("returns the tenant's users with role metadata (admin only)", async () => {
    const app = createApp();
    const res = await app.request("/users", { headers: adminHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toHaveLength(1);
    expect(body.users[0]).toMatchObject({ email: "admin@contract.test", role: "admin" });
  });

  it("rejects non-admin callers with 403", async () => {
    const app = createApp();
    const res = await app.request("/users", { headers });
    expect(res.status).toBe(403);
  });
});

describe("GET /tenants/:id/usage — real history (R12)", () => {
  it("returns usage rows instead of the old hardcoded []", async () => {
    const app = createApp();
    mockState.usageMonths = 2;
    const res = await app.request("/tenants/ten_test_123/usage", { headers: adminHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.usage.length).toBe(2);
    expect(body.usage[0]).toHaveProperty("casesProcessed");
  });
});

describe("POST /billing/portal — fail-soft contract", () => {
  it("returns 400 when the tenant has no Stripe customer", async () => {
    const app = createApp();
    const res = await app.request("/billing/portal", { method: "POST", headers });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.title).toBe("Bad Request");
  });
});

describe("plan gate (D5) — quota enforcement contract", () => {
  it("allows case creation under the plan limit", async () => {
    const app = createApp();
    const res = await app.request("/cases", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ companyName: "Acme Logistics BV", registrationNumber: "NL12345678", jurisdiction: "NL" }),
    });
    expect(res.status).toBe(201);
  });

  it("returns 402 Payment Required with upgrade info when the quota is exhausted", async () => {
    mockState.usageCases = 500; // == growth limit
    const app = createApp();
    const res = await app.request("/cases", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ companyName: "Over Limit BV", registrationNumber: "NL00000000", jurisdiction: "NL" }),
    });
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.title).toBe("Payment Required");
    expect(body.currentUsage).toBe(500);
    expect(body.limit).toBe(500);
    expect(body.upgradeUrl).toBe("/app#billing");
  });
});

describe("POST /cases/:id/report/verify — 404 contract", () => {
  it("returns 404 for a missing case", async () => {
    const app = createApp();
    const res = await app.request("/cases/case_missing/report/verify", { method: "POST", headers });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.title).toBe("Not Found");
  });
});

describe("GET /cases — search/filter/pagination contract (Phase C)", () => {
  it("exposes X-Total-Count and X-Page-Size headers", async () => {
    const app = createApp();
    const res = await app.request("/cases?limit=5&offset=0", { headers });
    expect(res.status).toBe(200);
    expect(Number(res.headers.get("X-Total-Count"))).toBeGreaterThanOrEqual(0);
    expect(Number(res.headers.get("X-Page-Size"))).toBe(5);
  });
});
