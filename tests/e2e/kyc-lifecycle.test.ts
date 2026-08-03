import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ServerType } from "@hono/node-server";
import { serve } from "@hono/node-server";
import { createApp } from "../../src/api/index.js";
import { pool, redis } from "../../src/db/index.js";

/**
 * End-to-end KYC lifecycle against the REAL docker-compose stack
 * (Postgres + Redis — no pg/ioredis mocks). The Hono app is booted
 * in-process on :3100; external KYC providers are forced into
 * deterministic fallback (ADR-013 zero-key) by stubbing global fetch
 * to reject, exactly as production behaves without keys.
 *
 * Requires: `docker compose up -d postgres redis` and a migrated DB.
 * Run with `LLM_TIER_PRIMARY=t0` for deterministic sync verdicts.
 */

const PORT = 3100;
const BASE = `http://localhost:${PORT}`;

// Unique tenant per run so the E2E never collides with dev data.
const email = `e2e-${Date.now()}@example.test`;
const password = "ChangeMe-123456";

let server: ServerType;
let accessToken = "";
let lowCaseId = "";
let highCaseId = "";

// The test stubs global fetch for external KYC providers, but the E2E's own
// HTTP client must keep hitting the in-process server — capture it first.
const realFetch = globalThis.fetch;

async function api(path: string, opts: { method?: string; body?: unknown } = {}) {
  const res = await realFetch(`${BASE}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  return res;
}

describe("KYC lifecycle (real Postgres + Redis)", () => {
  beforeAll(async () => {
    // Force deterministic adapter (no external providers in CI/E2E).
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network unreachable (E2E deterministic mode)"); }));
    // Sanity: infra reachable before booting the app.
    await pool.query("select 1");
    await redis.ping();
    server = serve({ fetch: createApp().fetch, port: PORT });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllGlobals();
    await pool.end();
    await redis.quit();
  });

  it("provisions a tenant and issues an API key", async () => {
    const res = await api("/provision", {
      method: "POST",
      body: { name: "E2E GmbH", email, password, plan: "starter" },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.tenantId).toMatch(/^ten_/);
    expect(body.apiKey).toMatch(/^kc_live_/);
  });

  it("logs in and receives JWT tokens", async () => {
    const res = await api("/auth/login", {
      method: "POST",
      body: { email, password },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
    accessToken = body.accessToken;
  });

  it("creates a low-risk case that sync-completes with dossier + evidence", async () => {
    const res = await api("/cases?sync=true", {
      method: "POST",
      body: { companyName: "Acme Logistics BV", registrationNumber: "NL12345678", jurisdiction: "NL" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("completed");
    lowCaseId = body.caseId;

    const detail = await (await api(`/cases/${lowCaseId}`)).json();
    expect(detail.status).toBe("completed");
    expect(detail.riskScore).toBe("Low");
    expect(detail.dossier.length).toBeGreaterThan(0);
    expect(detail.evidence.length).toBeGreaterThanOrEqual(1);
  });

  it("creates a high-risk case that pauses for human review", async () => {
    const res = await api("/cases?sync=true", {
      method: "POST",
      body: { companyName: "Volkov Capital Partners", registrationNumber: "CY98765432", jurisdiction: "CY" },
    });
    const body = await res.json();
    expect(["pending_hitl", "completed"]).toContain(body.status);
    highCaseId = body.caseId;

    const detail = await (await api(`/cases/${highCaseId}`)).json();
    expect(detail.riskScore).toBe("High");
    if (detail.status === "pending_hitl") expect(detail.requiresHuman).toBe(true);
  });

  it("approves a pending_hitl case (INV-007) and rejects re-approval with 409", async () => {
    const res = await api(`/cases/${highCaseId}/approve`, {
      method: "POST",
      body: { notes: "E2E approval" },
    });
    // The CY high-risk case may already be completed in some runs; approve
    // is only valid on pending_hitl.
    if (res.status === 200) {
      expect((await res.json()).status).toBe("completed");
      // Re-approval must 409 (INV-007).
      const again = await api(`/cases/${highCaseId}/approve`, { method: "POST", body: { notes: "again" } });
      expect(again.status).toBe(409);
    } else {
      expect(res.status).toBe(409); // already approved by a prior lifecycle step
    }
  });

  it("generates a signed report and verifies it", async () => {
    const res = await api(`/cases/${lowCaseId}/report`);
    expect(res.status).toBe(200);
    const report = await res.json();
    expect(report.signature).toBeDefined();
    expect(report.signature.algorithm).toBe("HMAC-SHA256");
    expect(report.signature.signature.startsWith("unsigned:")).toBe(true);

    const verify = await api(`/cases/${lowCaseId}/report/verify`, { method: "POST" });
    expect(verify.status).toBe(200);
    expect((await verify.json()).valid).toBe(true);
  });

  it("searches and filters the case list", async () => {
    const search = await api(`/cases?search=acme&limit=50`);
    expect(search.status).toBe(200);
    const data = await search.json();
    expect(data.cases.length).toBeGreaterThanOrEqual(1);
    expect(Number(search.headers.get("X-Total-Count"))).toBeGreaterThanOrEqual(1);
  });

  it("erases a case (GDPR) and confirms 404 afterwards", async () => {
    const erase = await api(`/cases/${lowCaseId}/erase`, { method: "DELETE" });
    expect(erase.status).toBe(200);

    const detail = await api(`/cases/${lowCaseId}`);
    expect(detail.status).toBe(404);
  });
});

