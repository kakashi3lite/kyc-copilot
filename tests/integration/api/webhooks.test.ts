import { beforeEach, expect, it, vi } from "vitest";
import { createApp } from "../../../src/api/index.js";

/**
 * Webhook delivery-history + replay routes (ADR-022).
 * DB is mocked at the pg layer (repo pattern — see auth.test.ts); the replay
 * service is mocked so these tests verify ROUTE CONTRACT (auth gate, tenant
 * scoping, 404/409/202 mapping). The replay service's DB logic is unit-tested
 * in tests/unit/services/webhooks-replay.test.ts.
 */

let mockDeliveryStatus = "failed"; // "failed" | "delivered" | "missing"
let mockWebhookOwner = true;
let mockStarterTenant = false;
let mockReplayResult: string = "replayed";
let mockBulkReplay: { replayed: number; skipped: number } | null = { replayed: 2, skipped: 1 };
const mockInserts: string[] = [];

vi.mock("bcrypt", () => {
  const compare = vi.fn(async (data: string, encrypted: string) => data === "kc_live_test_key" && encrypted === "mocked_hash");
  return { compare, hashSync: vi.fn(() => "mocked_hash"), hash: vi.fn(async () => "mocked_hash"), default: { compare } };
});

vi.mock("bullmq", () => {
  const Queue = vi.fn().mockImplementation(function () {
    return { add: vi.fn(), close: vi.fn() };
  });
  const Worker = vi.fn().mockImplementation(function () {
    return { close: vi.fn(), on: vi.fn() };
  });
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
      defineCommand: vi.fn((_n: string, _o: unknown) => {
        instance["rateLimitAtomic"] = vi.fn(async (_k: string, limit: number, _t: number) => [1, limit, limit - 1, 60]);
      }),
    };
    return instance;
  });
  return { Redis, default: Redis };
});

vi.mock("pg", () => {
  const queryMock = vi.fn().mockImplementation(async (config: any) => {
    const sqlText = typeof config === "string" ? config : config.text;
    const isArrayMode = typeof config === "object" && config.rowMode === "array";
    const toRows = <T extends Record<string, unknown>>(obj: T, cols: readonly (keyof T)[]) =>
      isArrayMode ? [cols.map((c) => obj[c])] : [obj];

    if (sqlText.trim().toLowerCase().startsWith("insert")) {
      mockInserts.push(sqlText);
      return { rows: [], rowCount: 1 };
    }
    if (sqlText.includes('from "tenants"')) {
      const tenant = {
        id: "ten_test_123",
        name: "Test Tenant",
        plan: mockStarterTenant ? "starter" : "growth",
        api_key_hash: "mocked_hash",
        api_key_id: "mocked_lookup_id",
        api_key_algo: "bcrypt",
        webhook_secret_encrypted: "enc",
        llm_budget_usd: "100.00",
        stripe_customer_id: "cus_stripe",
        active: true,
        created_at: new Date(),
        updated_at: new Date(),
        deleted_at: null,
      };
      // authenticateApiKey projects exactly [id, plan, active, apiKeyHash, apiKeyAlgo]
      // — array-mode rows must match the projection order, not the full table.
      const cols = ["id", "plan", "active", "api_key_hash", "api_key_algo"] as const;
      return { rows: toRows(tenant, cols) };
    }
    if (sqlText.includes('from "webhooks"')) {
      if (!mockWebhookOwner) return { rows: [] };
      const wh = {
        id: "wh_1",
        tenant_id: "ten_test_123",
        url_encrypted: "enc",
        url_mask: "https://acme.example/webhook",
        secret_encrypted: "enc",
        events: ["case.created", "case.completed"],
        active: true,
        created_at: new Date(),
        updated_at: new Date(),
      };
      const cols = ["id", "tenant_id", "url_encrypted", "url_mask", "secret_encrypted", "events", "active", "created_at", "updated_at"] as const;
      return { rows: toRows(wh, cols) };
    }
    if (sqlText.includes('from "webhook_deliveries"')) {
      if (mockDeliveryStatus === "missing") return { rows: [] };
      const d = {
        id: "del_1",
        webhook_id: "wh_1",
        tenant_id: "ten_test_123",
        event: "case.completed",
        payload: { caseId: "case_1" },
        attempts: 3,
        status: mockDeliveryStatus,
        next_attempt_at: new Date(),
        last_error: "HTTP 500",
        failed_at: mockDeliveryStatus === "failed" ? new Date() : null,
        last_http_status: 500,
        created_at: new Date(),
        updated_at: new Date(),
        deleted_at: null,
      };
      const cols = ["id", "webhook_id", "tenant_id", "event", "payload", "attempts", "status", "next_attempt_at", "last_error", "failed_at", "last_http_status", "created_at", "updated_at", "deleted_at"] as const;
      return { rows: toRows(d, cols) };
    }
    return { rows: [] };
  });
  const clientMock = { query: queryMock, release: vi.fn() };
  const Pool = vi.fn().mockImplementation(function () {
    return { connect: vi.fn(async () => clientMock), query: queryMock, end: vi.fn(async () => {}), on: vi.fn() };
  });
  return { Pool, default: { Pool } };
});

vi.mock("../../../src/services/webhooks/replay.js", () => ({
  replayDelivery: vi.fn(async () => mockReplayResult),
  replayAllForWebhook: vi.fn(async () => mockBulkReplay),
}));

vi.mock("../../../src/services/llm/router.js", () => ({
  DynamicLlmRouter: class {
    draftDossier = vi.fn();
  },
}));

const auth = { Authorization: "Bearer kc_live_test_key" };

beforeEach(() => {
  vi.clearAllMocks();
  mockDeliveryStatus = "failed";
  mockWebhookOwner = true;
  mockStarterTenant = false;
  mockReplayResult = "replayed";
  mockBulkReplay = { replayed: 2, skipped: 1 };
  mockInserts.length = 0;
});

it("GET /webhooks/:id/deliveries returns tenant-scoped history", async () => {
  const app = createApp();
  const res = await app.request("/webhooks/wh_1/deliveries", { headers: auth });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.deliveries).toHaveLength(1);
  expect(body.deliveries[0]).toMatchObject({ id: "del_1", status: "failed", lastHttpStatus: 500 });
});

it("GET /webhooks/:id/deliveries → 404 for a foreign webhook", async () => {
  mockWebhookOwner = false;
  const app = createApp();
  const res = await app.request("/webhooks/wh_1/deliveries", { headers: auth });
  expect(res.status).toBe(404);
});

it("replays a failed delivery → 202 {replayed: 1}", async () => {
  const app = createApp();
  const res = await app.request("/webhooks/wh_1/deliveries/del_1/replay", { method: "POST", headers: auth });
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ replayed: 1 });
});

it("replaying a delivered delivery → 409", async () => {
  mockReplayResult = "not_failed";
  const app = createApp();
  const res = await app.request("/webhooks/wh_1/deliveries/del_1/replay", { method: "POST", headers: auth });
  expect(res.status).toBe(409);
});

it("replaying a missing delivery → 404", async () => {
  mockReplayResult = "missing";
  const app = createApp();
  const res = await app.request("/webhooks/wh_1/deliveries/del_1/replay", { method: "POST", headers: auth });
  expect(res.status).toBe(404);
});

it("POST /webhooks/:id/replay → 202 {replayed, skipped}", async () => {
  const app = createApp();
  const res = await app.request("/webhooks/wh_1/replay", { method: "POST", headers: auth });
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ replayed: 2, skipped: 1 });
});

it("bulk replay of a foreign webhook → 404", async () => {
  mockBulkReplay = null;
  const app = createApp();
  const res = await app.request("/webhooks/wh_1/replay", { method: "POST", headers: auth });
  expect(res.status).toBe(404);
});

it("starter plan is rejected with 403 on every webhook endpoint", async () => {
  mockStarterTenant = true;
  const app = createApp();
  const history = await app.request("/webhooks/wh_1/deliveries", { headers: auth });
  const single = await app.request("/webhooks/wh_1/deliveries/del_1/replay", { method: "POST", headers: auth });
  const bulk = await app.request("/webhooks/wh_1/replay", { method: "POST", headers: auth });
  expect(history.status).toBe(403);
  expect(single.status).toBe(403);
  expect(bulk.status).toBe(403);
});

it("POST /cases enqueues case.created into webhook_deliveries", async () => {
  const app = createApp();
  const res = await app.request("/cases", {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ companyName: "Acme Logistics BV", registrationNumber: "NL12345678", jurisdiction: "NL" }),
  });
  expect(res.status).toBe(201);
  expect(mockInserts.some((sql) => sql.includes("webhook_deliveries"))).toBe(true);
});
