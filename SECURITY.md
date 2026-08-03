# SECURITY — KYC Copilot Production Security Posture

> Security controls, secret-handling policy, and the production-hardening
> checklist. Applies to every deployment (`development` · `staging` · `production`).

---

## 1. Security model at a glance

| Concern | Control | Where |
|---|---|---|
| PII at rest | AES-256-GCM field-level encryption (company names, registration numbers, source URLs) | `src/services/encryption/at-rest.ts` |
| PII in transit | TLS 1.2+ enforced; HSTS header on every response | `fly.toml` / `src/api/index.ts` |
| PII on display | Masked values only (masks derived server-side; decryption never reaches the UI) | `src/utils/mask.ts` |
| **PII in LLM prompts** 🆕 | **Deterministic pseudonym redaction — LLM providers never see real identity data (G1)** | `src/services/llm/pii-redactor.ts` |
| **Prompt injection defense** 🆕 | **XML-tagged entity data + anti-injection preamble in every LLM prompt (G11)** | `src/services/llm/adapters/prompt.ts` |
| **Graph tenant isolation** 🆕 | **All graph queries scoped by `tenantId`; cross-tenant entity resolution is opt-in (G3)** | `src/services/kyc-data/graph-query.ts`, `src/db/migrations/0004_colossal_slayback.sql` |
| Authentication (users) | Email + password → 15 min JWT access + 7 day refresh token, rotation on refresh, revocation on password reset | `src/api/routes/auth.ts`, `src/api/middleware/auth.ts` |
| Authentication (machines) | `kc_live_*` API keys → O(1) HMAC shadow index + constant-time digest compare | `src/api/middleware/auth.ts` |
| Rate limiting | Atomic Redis Lua token buckets (no TOCTOU between INCR and EXPIRE) | `src/api/middleware/rate-limit.ts` |
| Incoming webhooks | Stripe signature verification on the raw body; event id as idempotency PK | `src/api/routes/stripe-webhook.ts` |
| Outgoing webhooks | HMAC-SHA256 signed payloads, timing-safe verification, retry + DLQ | `src/services/webhooks/` |
| Report integrity | HMAC-SHA256 content signature + public verification endpoint | `src/services/reports/signer.ts` |
| Audit | Append-only hash-chained audit ledger for every state-changing action | `src/services/audit/logger.ts` |
| Abuse | Per-tenant plan quotas enforced in middleware (402 with upgrade link) | `src/api/middleware/plan-gate.ts` |

---

## 2. Secrets — handling policy

**Never commit a secret.** `.env`, `.env.*` (except `.env.example`), and all
credentials are git-ignored.

| Secret | Where it lives in prod | Rotation |
|---|---|---|
| `ENCRYPTION_KEY` (32-byte hex, AES-256-GCM) | Fly secrets (`infra/fly-secrets.sh`) | Manual; **rotating re-encrypts nothing** — do not change without a data-migration plan |
| `PII_REDACTION_KEY` (HMAC secret for LLM prompt pseudonyms) 🆕 | Fly secrets | MUST be distinct from `ENCRYPTION_KEY`, `JWT_SECRET`, and `API_KEY_LOOKUP_SECRET`. Rotating invalidates cached pseudonyms — LLM will see new pseudonyms for the same entities, which is harmless but may affect cross-call reasoning temporarily. |
| `JWT_SECRET` / `JWT_REFRESH_SECRET` | Fly secrets | Rotate to invalidate all sessions |
| `API_KEY_LOOKUP_SECRET` | Fly secrets | MUST be distinct from `JWT_SECRET` in production (a JWT leak must not forge lookup IDs) |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Fly secrets | Via Stripe Dashboard |
| `REPORT_SIGNING_KEY` (HMAC) | Fly secrets | Rotate = old reports lose verification — announce before rotating |
| `RESEND_API_KEY` | Fly secrets | Via Resend Dashboard |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | Fly secrets | Via provider console |
| Webhook signing secrets | Per-tenant, **encrypted at rest** in `webhooks.secret_encrypted` | Per-tenant rotation via API |

### Dev-mode defaults (safe only for local runs)

- `ENCRYPTION_KEY` defaults to a well-known dev key — **production must set its
  own** (see `infra/fly-secrets.sh` which generates one with `openssl rand -hex 32`).
- `JWT_SECRET` / `JWT_REFRESH_SECRET` default to dev strings — **production must
  set long random values** (`openssl rand -base64 48`).
- Empty `STRIPE_SECRET_KEY` = billing disabled (fail-soft) — the app keeps
  working, the plan gate skips subscription enforcement. This is deliberate:
  a misconfigured deployment degrades gracefully instead of locking customers out.

---

## 3. Production hardening checklist

Before shipping a public deployment, verify **all** of the following:

- [ ] `ENCRYPTION_KEY`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `API_KEY_LOOKUP_SECRET`
      set to fresh random values via `infra/fly-secrets.sh`.
- [ ] `PII_REDACTION_KEY` set to a fresh random value (distinct from all other secrets). 🆕
- [ ] `API_KEY_LOOKUP_SECRET` is **distinct** from `JWT_SECRET`.
- [ ] `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` configured; webhook endpoint
      `/stripe/webhook` registered in the Stripe Dashboard with all events.
- [ ] `REPORT_SIGNING_KEY` set (reports are unsigned otherwise — the PDF still
      shows a content hash, but it is not authenticated).
- [ ] `ALLOWED_ORIGINS` trimmed to the real origin(s) — CORS denies everything else.
- [ ] `NODE_ENV=production`, `LOG_LEVEL=info` (never `debug` in prod).
- [ ] Database is not reachable from the public internet (private networking).
- [ ] `.env` absent from the image; secrets injected via the platform.
- [ ] `docker build .` and `npm run test` green (coverage thresholds enforce
      60% lines / 40% branches).
- [ ] CSP / HSTS / X-Frame-Options headers confirmed on a live response.
- [ ] No `kc_live_demo...` key, demo password, or dev secret referenced in
      production environment files.
- [ ] A secret-scan run over the repo comes back clean.

---

## 4. Incident response notes

| Event | Immediate action |
|---|---|
| API key leaked | Regenerate tenant key; old key is a different HMAC — the leak invalidates on rotation |
| `JWT_SECRET` leaked | Rotate secret → all tokens invalid → users re-login |
| `ENCRYPTION_KEY` leaked | Rotate + schedule PII re-encryption (out of band) |
| `PII_REDACTION_KEY` leaked 🆕 | Rotate key → regenerate `infra/fly-secrets.sh` → old pseudonyms no longer match (LLM loses cross-call entity continuity temporarily; no PII exposure because pseudonyms are irreversible) |
| Webhook secret leaked | Rotate per tenant via API |
| Stripe signature failures | Check webhook endpoint secret + raw-body handling (never parse JSON before verification) |
| Rate-limit bypass suspected | Redis `KEYS rl:*` audit; raise `RATE_LIMIT_*` after review |

---

## 5. Reporting

For security issues, open a private issue in the repository. Include affected
version, reproduction steps, and the smallest impact summary that proves the
issue. Do **not** include live keys, tokens, or customer PII in the report.

## 6. Related Documents

| Document | Purpose |
|---|---|
| `docs/PLAN_SECURITY_HARDENING.md` | 12-point security hardening program — cryptographic defense in depth across 4 phases |
| `docs/BLUE_OCEAN_ARCHITECTURE.md` | Strategic roadmap including ZKP Privacy Shield and eIDAS verification |
| `docs/DECISIONS.md` | Architecture Decision Records (ADR-001 through ADR-013) |
