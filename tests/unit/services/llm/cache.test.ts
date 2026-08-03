import { beforeEach, describe, expect, it, vi } from "vitest";
import { RedisSemanticCache, cacheKey, hashCacheKey, CacheEntrySchema } from "../../../../src/services/llm/cache.js";
import type { CacheEntry } from "../../../../src/services/llm/cache.js";
import { initialState } from "../../../../src/graph/state.js";

// Map-backed ioredis mock so the cache is testable without a Redis server.
const mockStore = vi.hoisted(() => new Map<string, string>());

vi.mock("ioredis", () => {
  const Redis = vi.fn().mockImplementation(function () {
    return {
      get: vi.fn(async (key: string) => mockStore.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => {
        mockStore.set(key, value);
        return "OK";
      }),
      del: vi.fn(async (...keys: string[]) => {
        keys.forEach((k) => mockStore.delete(k));
        return keys.length;
      }),
      keys: vi.fn(async (pattern: string) => {
        const re = new RegExp(pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*"));
        return [...mockStore.keys()].filter((k) => re.test(k));
      }),
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

const cache = new RedisSemanticCache();

function entry(promptHash: string, ttlSeconds = 3600): CacheEntry {
  return {
    promptHash,
    response: {
      claims: [{ id: "c1", text: "Active company.", sourceKey: "API_1" }],
      riskScore: "Low",
      summary: "Assessed.",
    },
    modelId: "gpt-4o-mini",
    costSavedUsd: 0.01,
    createdAt: new Date().toISOString(),
    ttlSeconds,
  };
}

function stateFor(name: string, jurisdiction = "NL"): ReturnType<typeof initialState> {
  const state = initialState({ caseId: "case_1", tenantId: "ten_1", companyName: name, registrationNumber: "NL1", jurisdiction });
  state.apiData = {
    legalName: name, registrationNumber: "NL1", jurisdiction, status: "active",
    incorporationDate: null, address: null, ubos: [], sanctions: [], pep: false,
    sourceUrl: "urn:test", completeness: "complete",
  };
  return state;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStore.clear();
});

describe("RedisSemanticCache (Sprint 3)", () => {
  it("set then get returns the same entry", async () => {
    await cache.set(entry("a".repeat(64)));
    const got = await cache.get(`llm:cache:${"a".repeat(64)}`);
    expect(got).not.toBeNull();
    expect(got?.response.riskScore).toBe("Low");
  });

  it("get miss returns null", async () => {
    expect(await cache.get("llm:cache:missing")).toBeNull();
  });

  it("corrupt JSON entry is dropped and returns null", async () => {
    mockStore.set("llm:cache:corrupt", "{not-json");
    expect(await cache.get("llm:cache:corrupt")).toBeNull();
    expect(mockStore.has("llm:cache:corrupt")).toBe(false);
  });

  it("invalidate clears every cached key", async () => {
    await cache.set(entry("a".repeat(64)));
    await cache.set(entry("b".repeat(64)));
    await cache.invalidate("ten_1");
    expect(mockStore.size).toBe(0);
  });

  it("ttlForState: sanctions/PEP → short TTL, clean → long TTL", () => {
    const clean = stateFor("Acme");
    expect(cache.ttlForState(clean)).toBe(86400);

    const sanctioned = stateFor("Volkov");
    sanctioned.apiData = { ...sanctioned.apiData!, sanctions: [{ list: "eu", matched: true, name: "Volkov" }] };
    expect(cache.ttlForState(sanctioned)).toBe(3600);

    const pep = stateFor("PepCo");
    pep.apiData = { ...pep.apiData!, pep: true };
    expect(cache.ttlForState(pep)).toBe(3600);
  });
});

describe("cache keys", () => {
  it("hashCacheKey is deterministic for identical state", () => {
    const a = hashCacheKey(stateFor("Acme Logistics BV"));
    const b = hashCacheKey(stateFor("Acme Logistics BV"));
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it("differs for different entities", () => {
    expect(hashCacheKey(stateFor("Acme"))).not.toBe(hashCacheKey(stateFor("Globex")));
  });

  it("cacheKey is prefixed for the redis namespace", () => {
    expect(cacheKey(stateFor("Acme"))).toMatch(/^llm:cache:[0-9a-f]{64}$/);
  });

  it("includes graph context in the key digest", () => {
    const s = stateFor("Acme");
    const withCtx = hashCacheKey(s, {
      relatedEntities: [],
      priorCases: [{ caseId: "case_9", completedAt: "2026-08-01", riskScore: "High", summary: "x" }],
      entityResolution: { isNewEntity: false, canonicalName: "Acme", confidence: 1, mergedFrom: 2 },
    });
    expect(withCtx).not.toBe(hashCacheKey(s, null));
  });
});

describe("CacheEntrySchema (contract)", () => {
  it("validates a well-formed entry", () => {
    expect(CacheEntrySchema.safeParse(entry("a".repeat(64))).success).toBe(true);
  });

  it("rejects a malformed promptHash", () => {
    expect(CacheEntrySchema.safeParse(entry("short")).success).toBe(false);
  });
});
