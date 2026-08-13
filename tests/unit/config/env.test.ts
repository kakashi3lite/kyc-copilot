import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Production fail-closed guard (C2) — `src/config/env.ts`.
 *
 * The app must REFUSE to boot in NODE_ENV=production when any cryptographic
 * or auth secret is missing, or when a development-only default is present.
 * Development and test environments must keep booting with defaults so the
 * zero-key demo (LLM_TIER_PRIMARY=t0) and CI are never broken.
 */

const REQUIRED_SECRETS = [
  "ENCRYPTION_KEY",
  "JWT_SECRET",
  "JWT_REFRESH_SECRET",
  "API_KEY_LOOKUP_SECRET",
  "PII_REDACTION_KEY",
] as const;

/** A fully valid production environment (real-looking, non-default values). */
function validProdEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: "production",
    ENCRYPTION_KEY: "a".repeat(64),
    JWT_SECRET: "prod-jwt-secret-0123456789abcdef",
    JWT_REFRESH_SECRET: "prod-refresh-secret-0123456789abcdef",
    API_KEY_LOOKUP_SECRET: "b".repeat(64),
    PII_REDACTION_KEY: "c".repeat(64),
    S3_ACCESS_KEY: "prod-r2-access-key",
    S3_SECRET_KEY: "prod-r2-secret-key",
    ...overrides,
  };
}

/**
 * Apply a set of env vars for the next module load. Always clears the
 * required secrets first so a developer machine with real secrets exported
 * can never mask a "missing secret" scenario.
 */
function applyEnv(vars: Record<string, string>): void {
  for (const name of REQUIRED_SECRETS) delete process.env[name];
  for (const [key, value] of Object.entries(vars)) vi.stubEnv(key, value);
}

async function loadEnv(): Promise<typeof import("../../../src/config/env.js").env> {
  vi.resetModules();
  const mod = await import("../../../src/config/env.js");
  return mod.env;
}

describe("env production fail-closed guard", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("boots with development defaults when NODE_ENV is not production", async () => {
    applyEnv({ NODE_ENV: "development" });
    const env = await loadEnv();
    expect(env.NODE_ENV).toBe("development");
    expect(env.PII_REDACTION_ENABLED).toBe(true);
    expect(env.ENCRYPTION_KEY).toHaveLength(64);
  });

  it("refuses to boot in production when a single required secret is missing", async () => {
    const vars = validProdEnv();
    delete vars.PII_REDACTION_KEY;
    applyEnv(vars);
    await expect(loadEnv()).rejects.toThrow(/PII_REDACTION_KEY/);
  });

  it("refuses to boot in production when all secrets are missing and lists every gap", async () => {
    const vars = validProdEnv();
    for (const name of REQUIRED_SECRETS) delete vars[name];
    applyEnv(vars);
    await expect(loadEnv()).rejects.toThrow(/ENCRYPTION_KEY/);
    await expect(loadEnv()).rejects.toThrow(/JWT_SECRET/);
    await expect(loadEnv()).rejects.toThrow(/JWT_REFRESH_SECRET/);
    await expect(loadEnv()).rejects.toThrow(/API_KEY_LOOKUP_SECRET/);
    await expect(loadEnv()).rejects.toThrow(/PII_REDACTION_KEY/);
  });

  it("refuses to boot in production on a dev-default JWT_SECRET", async () => {
    applyEnv(validProdEnv({ JWT_SECRET: "dev-access-secret-change-me" }));
    await expect(loadEnv()).rejects.toThrow(/dev default/);
  });

  it("refuses to boot in production on MinIO S3 defaults", async () => {
    applyEnv(validProdEnv({ S3_ACCESS_KEY: "minioadmin", S3_SECRET_KEY: "minioadmin" }));
    await expect(loadEnv()).rejects.toThrow(/S3_ACCESS_KEY/);
  });

  it("boots in production when every secret is set to a non-default value", async () => {
    applyEnv(validProdEnv());
    const env = await loadEnv();
    expect(env.NODE_ENV).toBe("production");
    expect(env.PII_REDACTION_ENABLED).toBe(true);
    expect(env.JWT_SECRET).toBe("prod-jwt-secret-0123456789abcdef");
  });
});
