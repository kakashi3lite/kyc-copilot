---
repo: kyc-copilot
path: /Users/kakashi3lite/kyc-copilot
doc: SHIPPING_STATUS
title: Shipping Status — Sellable Product Capability Matrix
status: current
updated: 2026-08-04
scope: Business MVP (Phases A–G) · zero-key demo · sellable product surface
related: [PLAN_BUSINESS_MVP_IMPLEMENTATION.md, DECISIONS.md, ARCHITECTURE_CONTEXT.md, OPERATIONS.md]
---

# Shipping Status

> Capability matrix after the **Business MVP** (`PLAN_BUSINESS_MVP_IMPLEMENTATION.md`,
> Phases A–G, shipped 2026-08-04). Remaining stubs are documented, not deleted
> (conservative choice).

## ✅ Shipped — sellable product surface

| Capability | How it works | Evidence |
|---|---|---|
| Self-serve signup | `POST /provision` → tenant + user + Stripe customer + Checkout (14-day trial on Starter); duplicate email → 409 | `src/api/routes/auth.ts`, `public/signup.html` |
| JWT dashboard auth | Email/password → 15 min access + 7 day refresh tokens; silent refresh in `app.html`; hardcoded demo key removed | `src/api/routes/auth.ts`, `src/api/middleware/auth.ts`, `public/app.html` |
| Stripe subscription billing | Checkout, Customer Portal, subscription lifecycle synced via signed webhooks (idempotent by event id) | `src/services/billing/stripe.ts`, `src/api/routes/stripe-webhook.ts` |
| Plan quota enforcement | `requirePlanLimit("cases")` middleware → 402 + upgrade URL on exhaustion; subscription gate only when Stripe configured (fail-soft) | `src/api/middleware/plan-gate.ts` |
| Billing dashboard | Plan badge, usage meter (amber ≥90%), ROI, invoice history, portal redirect | `src/api/routes/billing.ts`, `public/app.html` |
| Team management | GET /users, invite, role change, soft-delete; admin-only; cannot self-remove/self-demote | `src/api/routes/users.ts` |
| Case search/filter/sort/pagination | `GET /cases` with `X-Total-Count`; 4-char mask keeps search usable ("Acme" → Acme) | `src/api/routes/cases.ts`, `src/utils/mask.ts` |
| Case detail panel | Slide-in dossier + evidence chain + audit trail + PDF/JSON/GDPR downloads + approve | `public/app.html` |
| Audit-grade reports | HMAC-SHA256 content-integrity signature (D6) replaces the PKCS#7 placeholder; verify endpoint | `src/services/reports/signer.ts`, `src/api/routes/cases.ts` |
| Real usage history | 6-month time-series from the `usage` table (zero-filled gaps) on `/usage` and `/tenants/:id/usage` | `src/api/routes/usage.ts`, `src/api/routes/tenants.ts` |
| Stripe metered usage | `reportMeteredUsageToStripe` after each processed case (idempotent per case) | `src/services/billing/usage-meter.ts` |
| Landing page + pricing | €99/€499/Custom cards, live ROI calculator, compliance badges, signup CTA | `public/landing.html` |
| Guided onboarding | `/app?welcome=1` modal + one-click first case + ceremony (🔔3) | `public/app.html` |
| Real E2E lifecycle | 8-step test against real Postgres + Redis (provision → login → low/high risk → approve → report verify → search → GDPR erase) | `tests/e2e/kyc-lifecycle.test.ts` |
| API contract tests | 10 tests for billing/usage/users/plan-gate/verify/search contracts + error shapes | `tests/integration/api/contract.test.ts` |
| Coverage gates | 60% lines / 40% branches / 55% functions / 60% statements enforced | `vitest.config.ts` |
| Docker compose test service | `docker compose run --rm test` runs the full suite against the real stack | `docker-compose.yml` |
| Zero-key demo intact | Acme → completed/Low; Volkov → pending_hitl/High; approve → completed; re-approve → 409 | `tests/e2e/kyc-lifecycle.test.ts`, `tests/integration/api/cases-keyless.test.ts` |

## 🧩 Remaining stubs (documented, NOT deleted)

| Stub | Location | Notes |
|---|---|---|
| `EmailService` / Resend | `src/services/notifications/` | Password-reset links logged in dev; wire Resend for prod email |
| S3 object storage | env vars only | `S3_*` configured + MinIO in compose but no S3 code; evidence lives in Postgres |
| `human-review.ts` node | `src/graph/nodes/` | Not in `KycGraph.run()`; approval is an API route |
| `cost-tracker.ts` | `src/services/llm/` | `recordTokenUsage` not called; `costUsd` not written per case |
| SSE live streaming | `GET /cases/stream` | Single snapshot then close |
| PKCS#7 (CA-issued) signatures | — | Deferred to Enterprise (D6 — HMAC signing is the MVP) |
| Full UBO real-key path | `opencorporates.ts` | Works with a key; zero-key deterministic mode returns `ubos: []` |
| `verifyWebhookSignature` in auth.ts | `src/api/middleware/auth.ts` | Duplicated by webhooks service verifier |
| ~8 unused npm deps | `package.json` | e.g. `boxen`, `chalk`, `ora`, `prompts`, `node-fetch`, `uuid` |

## 🚫 Out of scope (explicit)

SAML/SSO · scheduled re-screening cron · full PKCS#7/HSM signing · S3 evidence
offload · SSE live streaming · Resend email delivery · OTEL metrics export ·
localization/i18n · LICENSE file (add before public release).
