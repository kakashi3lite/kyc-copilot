import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 0 — production boot path. Proves the full Hono app assembles under
 * NODE_ENV=production with valid secrets, and that the fail-closed guard
 * (src/config/env.ts) blocks a boot with a missing secret.
 *
 * SKIP_DB_CHECK=true avoids the 30s startup DB-retry window (Fly cold-start
 * defense-in-depth in src/db/index.ts) — this test validates the app layer,
 * not the DB.
 */

function validProdEnv(): Record<string, string> {
  return {
    NODE_ENV: "production",
    SKIP_DB_CHECK: "true",
    ENCRYPTION_KEY: "a".repeat(64),
    JWT_SECRET: "prod-jwt-secret-0123456789abcdef",
    JWT_REFRESH_SECRET: "prod-refresh-secret-0123456789abcdef",
    API_KEY_LOOKUP_SECRET: "b".repeat(64),
    PII_REDACTION_KEY: "c".repeat(64),
    S3_ACCESS_KEY: "prod-r2-access-key",
    S3_SECRET_KEY: "prod-r2-secret-key",
  };
}

function applyEnv(vars: Record<string, string>): void {
  for (const [key, value] of Object.entries(vars)) vi.stubEnv(key, value);
}

describe("production boot", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("assembles the full app with valid production secrets and serves landing", async () => {
    applyEnv(validProdEnv());
    vi.resetModules();
    const { createApp } = await import("../../../src/api/index.js");
    const app = createApp();
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("refuses to assemble when a production secret is missing", async () => {
    const vars = validProdEnv();
    delete vars.ENCRYPTION_KEY;
    applyEnv(vars);
    vi.resetModules();
    await expect(import("../../../src/api/index.js")).rejects.toThrow(/ENCRYPTION_KEY/);
  });
});
