import { expect, it, vi, beforeEach } from "vitest";
import { createApp } from "../../../src/api/index.js";

let mockRedisIncrValue = 0;
const testApiKey = "kc_live_test_key";

vi.mock("bcrypt", () => {
  const compare = vi.fn(async (data: string, encrypted: string) => {
    return data === "kc_live_test_key" && encrypted === "mocked_hash";
  });
  const hashSync = vi.fn(() => "mocked_hash");
  const hash = vi.fn(async () => "mocked_hash");
  return {
    compare,
    hashSync,
    hash,
    default: { compare, hashSync, hash }
  };
});

vi.mock("bullmq", () => {
  const Queue = vi.fn().mockImplementation(function () {
    return {
      add: vi.fn(),
      close: vi.fn(),
    };
  });
  const Worker = vi.fn().mockImplementation(function () {
    return {
      close: vi.fn(),
      on: vi.fn(),
    };
  });
  return { Queue, Worker };
});

vi.mock("ioredis", () => {
  const Redis = vi.fn().mockImplementation(function () {
    const instance: Record<string, unknown> = {
      incr: vi.fn(async () => {
        if (mockRedisIncrValue > 0) {
          return mockRedisIncrValue;
        }
        return 1;
      }),
      expire: vi.fn(async () => 1),
      ping: vi.fn(async () => "PONG"),
      quit: vi.fn(async () => {}),
      on: vi.fn(),
    };
    // The rate-limit module calls `redis.defineCommand("rateLimitAtomic", ...)`
    // at module-load time. Real ioredis attaches the command as a method
    // on the instance itself (not just returning it). Mirror that here so
    // `redis.rateLimitAtomic(key, limit, ttl)` works the way the middleware
    // expects.
    instance["defineCommand"] = vi.fn((_name: string, _opts: unknown) => {
      instance["rateLimitAtomic"] = vi.fn(async (_key: string, limit: number, _ttl: number) => {
        const current = mockRedisIncrValue > 0 ? mockRedisIncrValue : 1;
        return [current, limit, Math.max(0, limit - current), 60] as [number, number, number, number];
      });
    });
    return instance;
  });
  return { Redis, default: Redis };
});

vi.mock("pg", () => {
  const queryMock = vi.fn().mockImplementation(async (config: any) => {
    const sqlText = typeof config === "string" ? config : config.text;
    const isArrayMode = typeof config === "object" && config.rowMode === "array";

    if (sqlText.includes('from "tenants"')) {
      const tenantObject = {
        id: "ten_test_123",
        name: "Test Tenant",
        plan: "growth",
        api_key_hash: "mocked_hash",
        api_key_id: "mocked_lookup_id",
        api_key_algo: "bcrypt",
        webhook_secret_encrypted: "whsec_encrypted",
        llm_budget_usd: "100.00",
        stripe_customer_id: "cus_stripe",
        active: true,
        created_at: new Date(),
        updated_at: new Date(),
        deleted_at: null,
      };

      if (isArrayMode) {
        return {
          rows: [
            [
              tenantObject.id,
              tenantObject.name,
              tenantObject.plan,
              tenantObject.api_key_hash,
              tenantObject.api_key_id,
              tenantObject.api_key_algo,
              tenantObject.webhook_secret_encrypted,
              tenantObject.llm_budget_usd,
              tenantObject.stripe_customer_id,
              tenantObject.active,
              tenantObject.created_at,
              tenantObject.updated_at,
              tenantObject.deleted_at,
            ]
          ]
        };
      }
      return { rows: [tenantObject] };
    }

    if (sqlText.includes('from "cases"')) {
      const caseObject = {
        id: "case_1",
        tenant_id: "ten_test_123",
        company_name_encrypted: "enc_company",
        company_name_mask: "Ac** Lo*******",
        registration_number_encrypted: "enc_reg",
        registration_number_mask: "NL****78",
        jurisdiction: "NL",
        status: "completed",
        risk_score: "Low",
        requires_human: false,
        ubo_verified: true,
        browser_failed: false,
        dossier: "Dossier text",
        graph_state: {},
        completed_at: new Date(),
        created_at: new Date(),
        updated_at: new Date(),
        deleted_at: null,
      };

      if (isArrayMode) {
        return {
          rows: [
            [
              caseObject.id,
              caseObject.tenant_id,
              caseObject.company_name_encrypted,
              caseObject.company_name_mask,
              caseObject.registration_number_encrypted,
              caseObject.registration_number_mask,
              caseObject.jurisdiction,
              caseObject.status,
              caseObject.risk_score,
              caseObject.requires_human,
              caseObject.ubo_verified,
              caseObject.browser_failed,
              caseObject.dossier,
              caseObject.graph_state,
              caseObject.completed_at,
              caseObject.created_at,
              caseObject.updated_at,
              caseObject.deleted_at,
            ]
          ]
        };
      }
      return { rows: [caseObject] };
    }

    return { rows: [] };
  });

  const clientMock = {
    query: queryMock,
    release: vi.fn(),
  };

  const Pool = vi.fn().mockImplementation(function () {
    return {
      connect: vi.fn(async () => clientMock),
      query: queryMock,
      end: vi.fn(async () => {}),
      on: vi.fn(),
    };
  });

  return { Pool, default: Pool };
});

vi.mock("../../../src/services/llm/router.js", () => {
  return {
    DynamicLlmRouter: class {
      draftDossier = vi.fn();
    }
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  mockRedisIncrValue = 0;
});

it("auth middleware - missing authorization header returns 401", async () => {
  const app = createApp();
  const res = await app.request("/cases", {
    method: "POST",
    headers: {},
  });
  expect(res.status).toBe(401);
  const body = await res.json() as { title: string; detail: string };
  expect(body.title).toBe("Unauthorized");
  expect(body.detail).toBe("Bearer token required");
});

it("auth middleware - invalid API key format or incorrect key returns 401", async () => {
  const app = createApp();
  const res = await app.request("/cases", {
    method: "POST",
    headers: {
      Authorization: "Bearer kc_live_wrong_key",
    },
  });
  expect(res.status).toBe(401);
  const body = await res.json() as { detail: string };
  expect(body.detail).toBe("Invalid API key");
});

it("auth middleware - valid API key returns 200/201 (or correct handler response)", async () => {
  const app = createApp();
  const res = await app.request("/cases", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${testApiKey}`,
    },
  });
  expect(res.status).toBe(200);
});

it("rate limiter - blocks requests after rapid attempts and returns 429", async () => {
  const app = createApp();

  // First request passes rate limit
  mockRedisIncrValue = 1;
  let res = await app.request("/cases", {
    method: "GET",
    headers: { Authorization: `Bearer ${testApiKey}` },
  });
  expect(res.status).toBe(200);

  // Second request passes rate limit
  mockRedisIncrValue = 2;
  res = await app.request("/cases", {
    method: "GET",
    headers: { Authorization: `Bearer ${testApiKey}` },
  });
  expect(res.status).toBe(200);

  // Third request exceeds rate limit (API limit is 100)
  mockRedisIncrValue = 150;
  res = await app.request("/cases", {
    method: "GET",
    headers: { Authorization: `Bearer ${testApiKey}` },
  });
  expect(res.status).toBe(429);
  const body = await res.json() as { title: string; detail: string };
  expect(body.title).toBe("Too Many Requests");
  expect(body.detail).toBe("Rate limit exceeded");
});
