import { bool, cleanEnv, num, port, str, url } from "envalid";

export const env = cleanEnv(process.env, {
  PORT: port({ default: 3000 }),
  NODE_ENV: str({
    choices: ["development", "staging", "production", "test"],
    default: "development",
  }),
  DATABASE_URL: url({ default: "postgres://kyc:kyc@localhost:5432/kyc" }),
  REDIS_URL: url({ default: "redis://localhost:6379" }),
  OPENAI_API_KEY: str({ default: "" }),
  COMPLY_ADVANTAGE_API_KEY: str({ default: "" }),
  COMPLY_ADVANTAGE_BASE_URL: url({
    default: "https://api.complyadvantage.com",
  }),
  LANGCHAIN_API_KEY: str({ default: "" }),
  ANTHROPIC_API_KEY: str({ default: "" }),
  GOOGLE_API_KEY: str({ default: "" }),
  OLLAMA_BASE_URL: url({ default: "http://localhost:11434" }),
  RESEND_API_KEY: str({ default: "" }),
  STRIPE_SECRET_KEY: str({ default: "" }),
  STRIPE_WEBHOOK_SECRET: str({ default: "" }),
  S3_ENDPOINT: url({ default: "http://minio:9000" }),
  S3_ACCESS_KEY: str({ default: "minioadmin" }),
  S3_SECRET_KEY: str({ default: "minioadmin" }),
  S3_BUCKET: str({ default: "kyc-evidence" }),
  ENCRYPTION_KEY: str({
    default: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  }),
  JWT_SECRET: str({ default: "dev-access-secret-change-me" }),
  JWT_REFRESH_SECRET: str({ default: "dev-refresh-secret-change-me" }),
  ALLOWED_ORIGINS: str({ default: "http://localhost:3000" }),
  PROXY_LIST: str({ default: "" }),
  RATE_LIMIT_API_PER_MINUTE: num({ default: 100 }),
  RATE_LIMIT_AUTH_PER_MINUTE: num({ default: 10 }),
  LOG_LEVEL: str({
    choices: ["trace", "debug", "info", "warn", "error", "fatal"],
    default: "info",
  }),
  OTEL_ENABLED: bool({ default: false }),
  LLM_TIER_PRIMARY: str({
    choices: ["t0", "t1", "t2", "t3", "t4"] as const,
    default: "t2",
  }),
  LLM_SYNC_ALLOWED_TIERS: str({ default: "t0,t2" }),
});

export function allowedOrigins(): string[] {
  return env.ALLOWED_ORIGINS.split(",")
    .map((origin: string) => origin.trim())
    .filter(Boolean);
}
