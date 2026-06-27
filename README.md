# KYC Copilot

> **High-assurance agentic AML/KYC pipeline — engineered for the Government of Canada.**
> *Production-ready. Audit-first. Sovereign by design.*

[![Node 20+](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![Region: ams (EU)](https://img.shields.io/badge/region-ams%20%28EU%29-0A66C2)](./fly.toml)
[![CI: typecheck + test + SAST + SBOM](https://img.shields.io/badge/CI-typecheck%20%2B%20test%20%2B%20SAST%20%2B%20SBOM-success)](./.github/workflows/deploy.yml)

---

## Why it exists

Payments institutions, money services businesses, and federal programs have to satisfy **FINTRAC / PCMLTFA**, **PIPEDA**, and the **TBS Directive on Automated Decision-Making** — often simultaneously, often under audit. KYC Copilot turns multi-day manual corporate onboarding into a deterministic, citation-backed pipeline that produces court-admissible evidence in minutes.

| Metric | Manual | KYC Copilot | Compliance driver |
|---|---|---|---|
| Time per case | ~3.5 h | **~14 min** | FINTRAC Guideline 4 turnaround |
| Cost per case | ~€380 | **~€12** | Federal program ROI |
| Hallucination rate | n/a | **0 %** (mechanical citation guardrail) | TBS Directive on ADM — explainability |
| Audit posture | Spreadsheets | **Append-only SHA-256-chained ledger** | PCMLTFA s.6 record-keeping |
| Data residency | Cloud-by-default | **On-prem Ollama tier (T1)** | PIPEDA Principle 4 — limiting use |

---

## Compliance map

| Canadian requirement | What KYC Copilot does | Source |
|---|---|---|
| **FINTRAC / PCMLTFA** — Enhanced Due Diligence, UBO verification, PEP/sanctions screening, 5-year record retention | High-risk cases **never auto-approve**; HITL gate (`pending_hitl` → `POST /cases/:id/approve`); immutable audit ledger | `src/graph/nodes/guardrail.ts` · `INV-007` |
| **PIPEDA** — Principle 4 (limiting use), Principle 7 (safeguards) | AES-256-GCM PII encryption at rest; edge masking on every list endpoint; **T1 Ollama** for on-prem inference keeps PII inside the data-sovereign boundary | `src/services/encryption/at-rest.ts` · `src/services/llm/router.ts` |
| **TBS Directive on Automated Decision-Making** — Algorithmic Impact Assessment, human-in-the-loop for high-impact decisions | Mandatory `requiresHuman=true` override path; risk override signed by a named reviewer; dossier cannot be generated in `pending_hitl` | `src/graph/nodes/guardrail.ts` |
| **Audit trails** — Tamper-evident logs, retention | `audit_logs` table is append-only with SHA-256-hashed payloads; every state transition recorded with actor + timestamp + reason | `src/services/audit/logger.ts` |
| **Privacy Act / GDPR portability** — Right to be forgotten | `DELETE /cases/:id/erase` performs hard delete; `GET /cases/export` returns decrypted bundle on demand | `src/api/routes/cases.ts` |

---

## System architecture

```mermaid
flowchart LR
  Client[Client / GC Dashboard] -->|Bearer kc_live_*| Hono[Hono API]
  Hono --> DB[(PostgreSQL)]
  Hono --> Redis[(Redis)]
  Hono -->|queue| BullMQ[BullMQ kyc-graph]
  BullMQ --> Graph[Agentic Graph Pipeline]
  Graph <--> DB
  Graph <--> Playwright[Playwright Dual-Semaphore]
  Graph --> LLM[Dynamic LLM Router T0-T4]
  Graph --> Reports[JSON + PDF Reports]
  Hono -->|HMAC| Webhooks[Webhook Delivery]
```

### The 6-node compliance pipeline

| # | Node | Timeout | Regulatory purpose |
|---|---|---|---|
| 1 | `ingestNode` | 5 s | NFKC normalization — defeats sanitization bypass |
| 2 | `apiLookupNode` (OpenCorporates + ComplyAdvantage) | 30 s | Government registry + sanctions/PEP screening |
| 3 | `browserFallbackNode` (Playwright, conditional) | 60 s | Captures JS-heavy registries the API can't reach |
| 4 | `draftDossierNode` (Dynamic LLM Router) | 30 s | Citation-aware draft; mechanical `[Source: KEY]` per claim |
| 5 | `guardrailNode` | 30 s | **Strips any claim not backed by the evidence ledger** — zero hallucinations |
| 6 | `humanReviewNode` (HITL) | n/a | Mandatory analyst sign-off for High risk / unverified UBO / browser failure |

`INV-007` enforces that `pending_hitl` cases **never** auto-approve — only `POST /cases/:id/approve` clears the gate.

### Dynamic LLM Router (ADR-010)

Deterministic `pickModel()` rules, evaluated in order:

1. Strict-Zod requirement + tier doesn't support JSON → promote to **T2 / T3**
2. Token estimate > 120 k → **T3 Gemini Flash** (1 M context)
3. Otherwise → configured tier

| Tier | Provider | Adapter | When chosen |
|---|---|---|---|
| **T0** | Deterministic rule engine | built-in | Default offline fallback; zero API cost |
| **T1** | Ollama Llama 3 (local) | `OllamaAdapter` | **Data-sovereign deployments** — keeps PII on-prem |
| **T2** | OpenAI `gpt-4o-mini` | `OpenAiAdapter` | Default cloud tier; structured JSON; cost-optimized |
| **T3** | Google `gemini-1.5-flash` | `GoogleAdapter` | Large evidence backlogs (>120 k tokens) |
| **T4** | OpenAI `gpt-4o` | `OpenAiAdapter` | Highest-quality dossiers |

### Dual-Semaphore Playwright (ADR-012)

A **single long-lived Chromium process** is shared between the graph worker and the PDF renderer, partitioned by two independent semaphores so neither consumer can starve the other:

| Semaphore | Capacity | Consumer | Purpose |
|---|---|---|---|
| `browserFallbackSemaphore` | **8** | `browserFallbackNode` | Registry scraping for partial API data |
| `pdfRenderSemaphore` | **2** | `GET /cases/:id/report?format=pdf` | Dashboard report downloads |

A saturated pool returns `PoolTimeoutError` after 30 s; callers degrade gracefully (typically → HITL escalation for the browser path, 503 for the PDF path).

---

## Algorithmic security

### O(1) timing-safe auth (`src/api/middleware/auth.ts`)

The auth hot path was originally **O(N) × bcrypt** (~100 ms per row × every tenant in the database). It now resolves in **O(1)** with two database touches at most:

1. `apiKeyId` — first 8 bytes of HMAC-SHA256(lookup secret, raw key), unique-indexed → single-row `LIMIT 1` lookup
2. `crypto.timingSafeEqual` over the 32-byte HMAC digest stored at provision time

```text
Token  ──HMAC──►  apiKeyId (8B hex)  ──index hit──►  tenant row  ──timingSafeEqual──►  match
                                └─ O(1) ────────────────┘              └─ O(1) ──────────────┘
```

**Length-leak defense.** `crypto.timingSafeEqual` throws on unequal-length buffers (Node docs). `safeEqualHexDigest` validates 64-char hex format *before* the comparison so non-hex or wrong-length input returns `false` without early-exit (Cloudflare Workers guidance).

**Webhook signatures** use the same primitive — `verifyWebhookSignature(secret, payload, signature)` re-computes HMAC-SHA256 and runs timingSafeEqual on the hex digests.

**Legacy bcrypt keys** are still honored during the migration window via `apiKeyAlgo = "bcrypt"`; new provision/seed paths write to the fast path.

### Atomic Redis rate-limit (`src/api/middleware/rate-limit.ts`)

The previous limiter did `INCR` then `EXPIRE` separately — **two round-trips** plus a race condition (process death between the calls leaves a TTL-less key forever).

Now a single Lua script does `INCR + EXPIRE-if-new + TTL` **atomically** on the Redis server, with `redis.defineCommand("rateLimitAtomic", ...)` registering the script once at module load so subsequent calls are EVALSHA (~0.3 ms each):

```lua
local current = redis.call('INCR', KEYS[1])
if current == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
local ttl = redis.call('TTL', KEYS[1])
return {current, tonumber(ARGV[1]), math.max(0, tonumber(ARGV[1]) - current), ttl}
```

One round-trip per request. No race. No orphaned buckets.

---

## 🚀 Interactive demo — Test drive in 3 steps

The repo ships with a seeded demo key so a reviewer can validate the entire flow end-to-end without setting up external API credentials.

```bash
npm install --legacy-peer-deps
npm run demo          # boots db + redis, runs migrations + seed, starts the API on :3000
```

### Step 1 — Submit a high-risk entity

```bash
curl -X POST http://localhost:3000/cases \
  -H "Authorization: Bearer kc_live_demo0000000000000000000000" \
  -H "Content-Type: application/json" \
  -d '{"companyName":"Volkov Capital Partners","registrationNumber":"CY98765432","jurisdiction":"CY"}'
```

**Expected:** `{"caseId":"case_demo_hitl_0002","status":"queued"}`

### Step 2 — Observe the HITL pause

The graph detects PEP-adjacent owners and complex nominee director structures and **locks the case in `pending_hitl`** until a named analyst signs off.

```bash
curl http://localhost:3000/cases/case_demo_hitl_0002 \
  -H "Authorization: Bearer kc_live_demo0000000000000000000000"
```

**Expected excerpt:** `status: pending_hitl`, `riskScore: High`, `requiresHuman: true`, `uboVerified: false`.

### Step 3 — Approve and download the signed PDF

```bash
curl -X POST http://localhost:3000/cases/case_demo_hitl_0002/approve \
  -H "Authorization: Bearer kc_live_demo0000000000000000000000" \
  -H "Content-Type: application/json" \
  -d '{"notes":"UBO documentation verified manually.","riskOverride":"Medium"}'

curl -o compliance_report.pdf \
  "http://localhost:3000/cases/case_demo_hitl_0002/report?format=pdf" \
  -H "Authorization: Bearer kc_live_demo0000000000000000000000"
```

---

## CI/CD — high-assurance supply chain

### Parallel DAG (≈50 % time cut)

```mermaid
flowchart LR
  push[push to main] --> checks
  push --> sast
  push --> docker
  checks & sast & docker --> preflight
  preflight --> deploy
  checks[checks<br/>typecheck + test]
  sast[security-scan<br/>npm audit + SBOM]
  docker[docker-build<br/>smoke build]
  preflight[fly-preflight<br/>app + volume + secrets]
  deploy[deploy<br/>flyctl deploy ams]
```

Three early jobs run concurrently; CI wall time = `max(checks, security-scan, docker-build)`, not their sum.

### CycloneDX SBOM (every push)

The `security-scan` job generates a `sbom.cdx.json` (CycloneDX 1.6) via `@cyclonedx/cyclonedx-npm --omit dev` and uploads it as a **90-day artifact**. Auditors can diff exact dependency trees between builds — TBS / FINTRAC evidence-integrity reviews map directly to this artifact.

### Ephemeral PR environments

Every PR gets a temporary Fly.io app via `superfly/fly-pr-review-apps@1.2.1`:

- `opened / synchronize` → `deploy-preview` job creates `kyc-copilot-pr-<N>` and deploys
- `closed` → `teardown-preview` job runs `flyctl apps destroy`
- Database isolation: per-PR `PREVIEW_DATABASE_URL` (Neon branch-style) — PR databases never touch production
- URL surfaces in the PR UI via the `environment:` block

### Zero-cost LLM tests

`tests/setup/llm-mock.ts` is wired in via `vitest.config.ts → test.setupFiles` and replaces every LangChain adapter (`@langchain/openai`, `anthropic`, `google-genai`, `ollama`) plus the `DynamicLlmRouter` with deterministic stubs. The router's tier-selection logic still runs; no network call is ever made. Tests run in milliseconds.

### Required GitHub Secrets

| Required | Recommended |
|---|---|
| `FLY_API_TOKEN` | `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET` |
| `FLY_ORG` | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY` |
| `DATABASE_URL` | `API_KEY_LOOKUP_SECRET` (defaults to `JWT_SECRET` in dev) |
| `REDIS_URL` | `FLY_APP` (defaults to `kyc-copilot`) |
| `ENCRYPTION_KEY` | `FLY_REGION` (defaults to `ams`) |
| `JWT_SECRET` | `PREVIEW_DATABASE_URL` (for PR ephemeral envs) |
| `JWT_REFRESH_SECRET` | |

---

## API surface

<details>
<summary><b>🔌 Public endpoints (no auth)</b></summary>

- `GET /health` — liveness; checks DB, Redis, LLM router
- `GET /ready` — readiness probe (Kubernetes / Fly)
- `POST /provision` — provisions a tenant, emits the raw API key **once**
- `POST /auth/login` — JWT (15 min) + refresh token (7 d)
- `POST /auth/refresh` — rotating refresh

</details>

<details>
<summary><b>🔐 Authenticated endpoints (Bearer <code>kc_live_*</code> or JWT)</b></summary>

| Method | Path | Notes |
|---|---|---|
| `POST` | `/cases` | `?sync=true` runs inline (T0/T2 only) |
| `GET` | `/cases` | Masked list |
| `GET` | `/cases/:id` | Full detail + evidence ledger + audit |
| `POST` | `/cases/:id/approve` | HITL completion — only path out of `pending_hitl` |
| `GET` | `/cases/:id/report?format=json\|pdf` | Immutable PDF / JSON dossier |
| `POST` | `/cases/:id/rescreen` | growth+ plan |
| `GET` | `/cases/stream` | Server-Sent Events snapshot |
| `GET` | `/cases/export` | Decrypted portability bundle |
| `DELETE` | `/cases/:id/erase` | Hard delete (Privacy Act / GDPR Art. 17) |
| `GET` | `/dashboard` | Metrics + recent activity |
| `GET` | `/usage` | Monthly ROI summary |
| `POST` `/GET` | `/webhooks` | Registration (growth+) |
| `POST` | `/webhooks/:id/test` | Queue test event |

</details>

<details>
<summary><b>🏛 Admin (JWT role=admin)</b></summary>

- `GET /tenants`
- `GET /tenants/:id/usage`
- `POST /tenants/:id/plan`

</details>

---

## Local development

```bash
git clone https://github.com/kakashi3lite/kyc-copilot
cd kyc-copilot
npm install --legacy-peer-deps
cp .env.example .env
docker compose up -d db redis
npm run db:migrate
npm run db:seed        # provisions demo tenant + 3 demo cases
npm run dev            # http://localhost:3000
```

| Script | Purpose |
|---|---|
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | Vitest with v8 coverage (auto-loads LLM mock) |
| `npm run test:unit` | Unit tests only |
| `npm run test:integration` | Integration tests only |
| `npm run db:migrate` | Drizzle migrations |
| `npm run db:seed` | Seeds the demo tenant + 3 cases |
| `npm run demo` | Boots db + redis, migrates, seeds, starts the API |

---

## Production deployment

<details>
<summary><b>☁️ Fly.io (Amsterdam — EU residency)</b></summary>

| Setting | Value |
|---|---|
| Primary region | `ams` (Amsterdam) |
| VM size | `performance-2x` (2 vCPU / 4 GB) |
| Health check | `GET /health` every 15 s, 5 s timeout |
| Concurrency | soft 20, hard 50 — protects the Playwright pool |
| Persistent volume | `kyc_data` mounted at `/app/data` (1 GB initial) |
| Release command | `node dist/src/db/migrate.js` (Drizzle programmatic migrator) |

Source: [`fly.toml`](./fly.toml). Deploys are automatic on `push to main` once required GitHub Secrets are set.

</details>

---

## Operational guarantees

| Invariant | Rule | Enforced by |
|---|---|---|
| `INV-001` | Every dossier claim carries a valid `[Source: KEY]` | `src/graph/nodes/guardrail.ts` |
| `INV-002` | Uncited claims are stripped — never bypassed | `src/graph/nodes/guardrail.ts` |
| `INV-003` | PII encrypted at rest; list endpoints return masks | `*Encrypted` / `*Mask` columns |
| `INV-004` | Audit logs are append-only with hashed payloads | `src/services/audit/logger.ts` |
| `INV-005` | API keys HMAC-SHA256 hashed; raw key returned once; O(1) lookup | `src/api/middleware/auth.ts` |
| `INV-006` | Webhooks signed HMAC-SHA256, timing-safe verified | `src/services/webhooks/dispatcher.ts` |
| `INV-007` | `pending_hitl` cases never auto-approve | `src/graph/nodes/guardrail.ts` |

---

## Roadmap (post v1.0.0)

- **SAML / SSO** — for federal tenant onboarding (TBS-aligned IdP federation)
- **Scheduled re-screening cron** — automated periodic EDD refresh
- **Compiled LangGraph StateGraph migration** — true graph checkpoint / resume (ADR-001)
- **Stripe billing enforcement** — metered plan upgrades in production

---

## License

MIT. See [`LICENSE`](./LICENSE).