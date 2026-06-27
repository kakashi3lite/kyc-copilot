#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# KYC Copilot — Fly.io Secrets Injection
# Run this script ONCE after `fly launch` / `fly apps create`.
#
# IMPORTANT: Replace all placeholder values with real credentials before running.
# Secrets are encrypted at rest and injected as environment variables at boot.
# They are NEVER written to fly.toml or committed to version control.
#
# Usage: chmod +x infra/fly-secrets.sh && ./infra/fly-secrets.sh
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

APP_NAME="kyc-copilot"
echo "🔐 Injecting secrets into Fly.io app: ${APP_NAME}"
echo "   Region: ams (Amsterdam) — EU data residency"
echo ""

# ── 1. Database (Fly Postgres) ───────────────────────────────────────────────
# After running: fly postgres create --name kyc-copilot-db --region ams
#                fly postgres attach kyc-copilot-db --app kyc-copilot
# Fly auto-injects DATABASE_URL, but we set it explicitly for control.
echo "📦 Setting Database secrets..."
fly secrets set \
  DATABASE_URL="postgres://kyc_copilot:CHANGE_ME_DB_PASSWORD@kyc-copilot-db.flycast:5432/kyc_copilot?sslmode=disable" \
  --app "${APP_NAME}"

# ── 2. Redis / Cache (Upstash via Fly) ───────────────────────────────────────
# After running: fly redis create --name kyc-copilot-redis --region ams
# Or use Upstash directly: https://console.upstash.com
echo "📦 Setting Redis secrets..."
fly secrets set \
  REDIS_URL="rediss://default:CHANGE_ME_REDIS_TOKEN@fly-kyc-copilot-redis.upstash.io:6379" \
  --app "${APP_NAME}"

# ── 3. LLM Provider Keys ────────────────────────────────────────────────────
# Only set keys for providers you intend to use.
# The DynamicLlmRouter falls back to T0 (deterministic) if keys are missing.
echo "🤖 Setting LLM provider secrets..."
fly secrets set \
  OPENAI_API_KEY="sk-CHANGE_ME_OPENAI_KEY" \
  ANTHROPIC_API_KEY="sk-ant-CHANGE_ME_ANTHROPIC_KEY" \
  GOOGLE_API_KEY="CHANGE_ME_GOOGLE_API_KEY" \
  LANGCHAIN_API_KEY="" \
  LLM_TIER_PRIMARY="t2" \
  LLM_SYNC_ALLOWED_TIERS="t0,t2" \
  --app "${APP_NAME}"

# ── 4. Encryption & Auth ────────────────────────────────────────────────────
# ENCRYPTION_KEY: 32 bytes hex-encoded (AES-256-GCM for PII at-rest encryption)
# Generate with: openssl rand -hex 32
# JWT secrets: Use long random strings. Generate with: openssl rand -base64 48
echo "🔑 Setting Encryption & Auth secrets..."
fly secrets set \
  ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  JWT_SECRET="$(openssl rand -base64 48)" \
  JWT_REFRESH_SECRET="$(openssl rand -base64 48)" \
  --app "${APP_NAME}"

# ── 5. Object Storage (Cloudflare R2 / Tigris) ──────────────────────────────
# Cloudflare R2: https://<account-id>.r2.cloudflarestorage.com
# Tigris (Fly):  https://fly.storage.tigris.dev
echo "📁 Setting Object Storage secrets..."
fly secrets set \
  S3_ENDPOINT="https://CHANGE_ME_ACCOUNT_ID.r2.cloudflarestorage.com" \
  S3_ACCESS_KEY="CHANGE_ME_R2_ACCESS_KEY" \
  S3_SECRET_KEY="CHANGE_ME_R2_SECRET_KEY" \
  S3_BUCKET="kyc-evidence" \
  S3_REGION="auto" \
  --app "${APP_NAME}"

# ── 6. External APIs ────────────────────────────────────────────────────────
echo "🌐 Setting External API secrets..."
fly secrets set \
  COMPLY_ADVANTAGE_API_KEY="CHANGE_ME_COMPLY_ADVANTAGE_KEY" \
  COMPLY_ADVANTAGE_BASE_URL="https://api.complyadvantage.com" \
  RESEND_API_KEY="re_CHANGE_ME_RESEND_KEY" \
  STRIPE_SECRET_KEY="sk_live_CHANGE_ME_STRIPE_KEY" \
  STRIPE_WEBHOOK_SECRET="whsec_CHANGE_ME_STRIPE_WEBHOOK" \
  --app "${APP_NAME}"

# ── 7. Network & Observability ───────────────────────────────────────────────
echo "🌍 Setting Network & Observability secrets..."
fly secrets set \
  ALLOWED_ORIGINS="https://kyc-copilot.fly.dev,https://app.your-domain.eu" \
  PROXY_LIST="" \
  RATE_LIMIT_API_PER_MINUTE="100" \
  RATE_LIMIT_AUTH_PER_MINUTE="10" \
  LOG_LEVEL="info" \
  OTEL_ENABLED="false" \
  --app "${APP_NAME}"

echo ""
echo "✅ All secrets injected for ${APP_NAME}."
echo "   Run 'fly secrets list --app ${APP_NAME}' to verify."
echo "   Run 'fly deploy --region ams' to deploy with these secrets."
