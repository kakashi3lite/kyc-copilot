import { bool, cleanEnv, makeValidator, num, port, str, url } from "envalid";

/**
 * Custom validator for database/redis connection strings.
 * envalid's built-in `url()` rejects Fly.io internal URIs
 * (e.g., `postgres://...@app-db.flycast:5432/db?sslmode=disable`)
 * and Upstash Redis TLS URIs (`rediss://...`). This validator
 * accepts any string starting with a known protocol scheme.
 */
const connStr = makeValidator<string>((input: string) => {
  const schemes = ["postgres://", "postgresql://", "redis://", "rediss://"];
  if (!schemes.some((s) => input.startsWith(s))) {
    throw new Error(`Expected connection string starting with ${schemes.join(" | ")}, got: ${input.slice(0, 20)}...`);
  }
  return input;
});

/**
 * Custom validator for S3-compatible endpoint URIs.
 * Accepts http/https for MinIO, Cloudflare R2, Tigris, etc.
 */
const s3Endpoint = makeValidator<string>((input: string) => {
  if (!input.startsWith("http://") && !input.startsWith("https://")) {
    throw new Error(`Expected S3 endpoint starting with http:// or https://, got: ${input.slice(0, 20)}...`);
  }
  return input;
});

export const env = cleanEnv(process.env, {
  PORT: port({ default: 3000 }),
  NODE_ENV: str({
    choices: ["development", "staging", "production", "test"],
    default: "development",
  }),

  // ── Database & Cache ────────────────────────────────────────────────────
  // Fly Postgres: postgres://user:pass@kyc-copilot-db.flycast:5432/kyc?sslmode=disable
  // Local:        postgres://kyc:kyc@localhost:5432/kyc
  DATABASE_URL: connStr({ default: "postgres://kyc:kyc@localhost:5432/kyc" }),
  // Fly Redis (Upstash): rediss://default:token@fly-kyc-copilot-redis.upstash.io:6379
  // Local:               redis://localhost:6379
  REDIS_URL: connStr({ default: "redis://localhost:6379" }),

  // ── LLM Provider Keys ──────────────────────────────────────────────────
  OPENAI_API_KEY: str({ default: "" }),
  ANTHROPIC_API_KEY: str({ default: "" }),
  GOOGLE_API_KEY: str({ default: "" }),
  LANGCHAIN_API_KEY: str({ default: "" }),
  OLLAMA_BASE_URL: url({ default: "http://localhost:11434" }),
  LLM_TIER_PRIMARY: str({
    choices: ["t0", "t1", "t2", "t3", "t4"] as const,
    default: "t2",
  }),
  LLM_SYNC_ALLOWED_TIERS: str({ default: "t0,t2" }),

  // ── External APIs ──────────────────────────────────────────────────────
  COMPLY_ADVANTAGE_API_KEY: str({ default: "" }),
  COMPLY_ADVANTAGE_BASE_URL: url({
    default: "https://api.complyadvantage.com",
  }),
  RESEND_API_KEY: str({ default: "" }),
  STRIPE_SECRET_KEY: str({ default: "" }),
  STRIPE_WEBHOOK_SECRET: str({ default: "" }),

  // ── Object Storage (S3-compatible) ─────────────────────────────────────
  // Cloudflare R2:  https://<account-id>.r2.cloudflarestorage.com
  // Tigris (Fly):   https://fly.storage.tigris.dev
  // Local MinIO:    http://minio:9000
  S3_ENDPOINT: s3Endpoint({ default: "http://minio:9000" }),
  S3_ACCESS_KEY: str({ default: "minioadmin" }),
  S3_SECRET_KEY: str({ default: "minioadmin" }),
  S3_BUCKET: str({ default: "kyc-evidence" }),
  S3_REGION: str({ default: "auto" }),

  // ── Encryption & Auth ──────────────────────────────────────────────────
  ENCRYPTION_KEY: str({
    default: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  }),
  JWT_SECRET: str({ default: "dev-access-secret-change-me" }),
  JWT_REFRESH_SECRET: str({ default: "dev-refresh-secret-change-me" }),
  /**
   * HMAC secret used to derive the indexable apiKeyId from raw API keys.
   * MUST be distinct from JWT_SECRET in production. Defaults to JWT_SECRET
   * only for dev convenience.
   */
  API_KEY_LOOKUP_SECRET: str({ default: "" }),

  // ── Network & Security ─────────────────────────────────────────────────
  ALLOWED_ORIGINS: str({ default: "http://localhost:3000" }),
  PROXY_LIST: str({ default: "" }),
  RATE_LIMIT_API_PER_MINUTE: num({ default: 100 }),
  RATE_LIMIT_AUTH_PER_MINUTE: num({ default: 10 }),

  // ── Observability ──────────────────────────────────────────────────────
  LOG_LEVEL: str({
    choices: ["trace", "debug", "info", "warn", "error", "fatal"],
    default: "info",
  }),
  OTEL_ENABLED: bool({ default: false }),
});

export function allowedOrigins(): string[] {
  return env.ALLOWED_ORIGINS.split(",")
    .map((origin: string) => origin.trim())
    .filter(Boolean);
}
