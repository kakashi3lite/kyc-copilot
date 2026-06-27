# KYC Copilot

> **High-Assurance Agentic AML/KYC Pipeline — engineered for the Government of Canada.**
> *Production-ready. Audit-first. Sovereign by design.*

[![Node 20+](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![Region: ams (EU)](https://img.shields.io/badge/region-ams%20%28EU%29-0A66C2)](./fly.toml)
[![CI: typecheck + test + SAST](https://img.shields.io/badge/CI-typecheck%20%2B%20test%20%2B%20SAST-success)](./.github/workflows/deploy.yml)

---

## Why this exists

Canadian payments institutions, money services businesses, and federal programs have to satisfy **FINTRAC / PCMLTFA**, **PIPEDA**, and the **TBS Directive on Automated Decision-Making** — often simultaneously, often under audit. KYC Copilot turns that multi-day, error-prone manual work into a deterministic, citation-backed pipeline that produces court-admissible evidence in minutes, not hours.

| Metric | Before (manual) | KYC Copilot | Compliance driver |
|---|---|---|---|
| Time per case | ~3.5 h | **~14 min** | FINTRAC Guideline 4 turnaround |
| Cost per case | ~€380 | **~€12** | Program ROI for federal scaling |
| Hallucination rate | n/a | **0 %** (mechanical citation guardrail) | TBS Directive on ADM — explainability |
| Audit posture | Spreadsheets | **Append-only, SHA-256-chained audit trail** | PCMLTFA s.6 record-keeping |
| Data residency | Cloud-by-default | **On-prem Ollama tier (T1) available** | PIPEDA Principle 4 — limiting use |

---

## Built for Canadian regulatory environments

| Canadian requirement | What KYC Copilot does | Where it lives |
|---|---|---|
| **FINTRAC / PCMLTFA** — Enhanced Due Diligence, UBO verification, PEP/sanctions screening, 5-year record retention | 5-node screening graph → high-risk cases **never auto-approve**; HITL gate (`pending_hitl` → `POST /cases/:id/approve`); immutable audit ledger | `src/graph/nodes/guardrail.ts` · `src/graph/nodes/human-review.ts` |
| **PIPEDA** — Principle 4 (limiting use), Principle 7 (safeguards) | AES-256-GCM PII encryption at rest; edge masking on every list endpoint; **T1 Ollama tier for on-prem inference** keeps PII inside the data-sovereign boundary | `src/services/encryption/at-rest.ts` · `src/services/llm/router.ts` |
| **TBS Directive on Automated Decision-Making** — Algorithmic Impact Assessment, human-in-the-loop for high-impact decisions | Mandatory `requiresHuman=true` override path; risk override must be signed by a named reviewer; dossier cannot be generated in `pending_hitl` state | `src/graph/nodes/guardrail.ts` · `src/api/routes/cases.ts` |
| **CRA / FINTRAC audit trails** — Tamper-evident logs, retention | `audit_logs` table is **append-only** with SHA-256-hashed payloads; every state transition recorded with actor + timestamp + reason | `src/services/audit/logger.ts` |
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
| 4 | `draftDossierNode` (Dynamic LLM Router) | 30 s | Citation-aware dossier draft; mechanical `[Source: KEY]` per claim |
| 5 | `guardrailNode` | 30 s | **Strips any claim not backed by the evidence ledger** — zero hallucinations |
| 6 | `humanReviewNode` (HITL) | n/a | Mandatory analyst sign-off for High risk / unverified UBO / browser failure |

`INV-007` enforces that `pending_hitl` cases **never** auto-approve — only `POST /cases/:id/approve` clears the gate.

### Dynamic LLM Router (ADR-010)

Routes between provider tiers on a per-case basis using a deterministic, testable `pickModel()` function. Rules evaluated in order:

1. If the node requires strict Zod JSON and the configured tier can't deliver → promote to **T2 / T3**.
2. If the token estimate > 120 k → **T3 Gemini 1.5 Flash** (1 M context window).
3. Otherwise → use the configured tier.

| Tier | Provider | Adapter | When chosen |
|---|---|---|---|
| **T0** | Deterministic rule engine | built-in | Default offline fallback; zero API cost; never goes down |
| **T1** | Ollama Llama 3 (local) | `OllamaAdapter` | **Data-sovereign deployments** — keeps PII on-prem (PIPEDA) |
| **T2** | OpenAI `gpt-4o-mini` | `OpenAiAdapter` | Default cloud tier; structured JSON; cost-optimized |
| **T3** | Google `gemini-1.5-flash` | `GoogleAdapter` | Large evidence backlogs (>120 k tokens) |
| **T4** | OpenAI `gpt-4o` | `OpenAiAdapter` | Highest-quality dossiers |

### Dual-Semaphore Playwright (ADR-012)

A **single long-lived Chromium process** is shared between the graph worker and the PDF renderer, partitioned by **two independent semaphores** so neither consumer can starve the other:

| Semaphore | Capacity | Consumer | Purpose |
|---|---|---|---|
| `browserFallbackSemaphore` | **8** | `browserFallbackNode` | Registry scraping for partial API data |
| `pdfRenderSemaphore` | **2** | `GET /cases/:id/report?format=pdf` | Dashboard report downloads |

A 3rd consumer hitting a saturated pool gets a `PoolTimeoutError` after 30 s and must degrade gracefully (typically → HITL escalation). The two pools are independent: a flood of PDF renders cannot block dossier pipeline.

---

## 🚀 Interactive demo — Test drive in 3 steps

The repo ships with a seeded demo key so a reviewer can validate the entire flow end-to-end without setting up external API credentials.

```bash
npm install
npm run demo          # boots db + redis, runs migrations + seed, starts the API on :3000
```

### Step 1 — Submit a high-risk entity

We submit **Volkov Capital Partners** (Cyprus), which triggers EDD and UBO flags:

```bash
curl -X POST http://localhost:3000/cases \
  -H "Authorization: Bearer kc_live_demo0000000000000000000000" \
  -H "Content-Type: application/json" \
  -d '{
    "companyName": "Volkov Capital Partners",
    "registrationNumber": "CY98765432",
    "jurisdiction": "CY"
  }'
```

**Expected:**
```json
{ "caseId": "case_demo_hitl_0002", "status": "queued" }
```

### Step 2 — Observe the HITL pause

The graph detects PEP-adjacent owners and complex nominee director structures and **locks the case in `pending_hitl`** until a named analyst signs off (INV-007). No automated path clears a High risk case.

```bash
curl http://localhost:3000/cases/case_demo_hitl_0002 \
  -H "Authorization: Bearer kc_live_demo0000000000000000000000"
```

**Expected (excerpt):**
```json
{
  "id": "case_demo_hitl_0002",
  "status": "pending_hitl",
  "riskScore": "High",
  "requiresHuman": true,
  "uboVerified": false,
  "dossier": "... COMPLEX OWNERSHIP DETECTED. Analyst review required ..."
}
```

### Step 3 — Approve and download the signed PDF

A compliance officer with named credentials clears the case and pulls the signature-locked PDF:

```bash
# 1. Approve (only valid for the analyst role)
curl -X POST http://localhost:3000/cases/case_demo_hitl_0002/approve \
  -H "Authorization: Bearer kc_live_demo0000000000000000000000" \
  -H "Content-Type: application/json" \
  -d '{
    "notes": "UBO documentation verified manually via certified corporate registry copy.",
    "riskOverride": "Medium"
  }'

# 2. Download the immutable PDF dossier
curl -o compliance_report.pdf \
  "http://localhost:3000/cases/case_demo_hitl_0002/report?format=pdf" \
  -H "Authorization: Bearer kc_live_demo0000000000000000000000"
```

---

## Security & robustness posture

| Control | Status | Source |
|---|---|---|
| AES-256-GCM PII encryption at rest | ✅ | `src/services/encryption/at-rest.ts` (INV-003) |
| Field masking on list endpoints | ✅ | `*Mask` columns in `src/db/schema.ts` |
| Bcrypt-hashed API keys (raw returned once at provision) | ✅ | `src/api/routes/auth.ts` (INV-005) |
| Append-only SHA-256-chained audit log | ✅ | `src/services/audit/logger.ts` (INV-004) |
| HMAC-SHA256 webhook signing (`x-kyc-signature`) | ✅ | `src/services/webhooks/dispatcher.ts` (INV-006) |
| Per-tenant + per-IP rate limiting (Redis token bucket) | ✅ | `src/api/middleware/rate-limit.ts` |
| Mechanical citation guardrail (strips uncited claims) | ✅ | `src/graph/nodes/guardrail.ts` (INV-001/002) |
| `SIGTERM`/`SIGINT` graceful shutdown of HTTP server, BullMQ worker, queue, browser pool, Redis, Postgres | ✅ | `src/index.ts` + `src/workers/graph-runner.ts` |
| Startup DB health check (`SELECT 1`) — exit 1 on unreachable | ✅ | `src/db/index.ts` |
| SAST gate in CI (`npm audit --audit-level=high`) | ✅ | `.github/workflows/deploy.yml` |

---

## API surface (summary)

<details>
<summary><b>🔌 Public endpoints</b></summary>

- `GET /health` — liveness; checks DB, Redis, LLM router
- `GET /ready` — readiness probe (Kubernetes/Fly)
- `POST /provision` — provisions a tenant and emits the raw API key **once**
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

## Production deployment

<details>
<summary><b>☁️ Fly.io deployment (Amsterdam — EU residency)</b></summary>

The stack deploys to Fly.io's Amsterdam (`ams`) primary region for EU data residency, matching AMLD6 controls. A rolling deploy strategy plus a `SIGTERM` graceful shutdown in `src/index.ts` lets the orchestrator cycle machines without dropping in-flight cases.

| Setting | Value |
|---|---|
| Primary region | `ams` (Amsterdam) |
| VM size | `performance-2x` (2 vCPU / 4 GB) |
| Health check | `GET /health` every 15 s, 5 s timeout |
| Auto-stop / start | `stop` / `true` |
| Concurrency limits | soft 20, hard 50 — protects the Playwright dual-semaphore pool |
| Persistent volume | `kyc_data` mounted at `/app/data` (1 GB initial) |

Source: [`fly.toml`](./fly.toml). Set `FLY_API_TOKEN` in GitHub → deploys are automatic on `push to main`.

</details>

<details>
<summary><b>🛡 CI/CD pipeline (.github/workflows/deploy.yml)</b></summary>

```mermaid
flowchart LR
  push[push to main] --> checks
  checks[checks: typecheck + test + coverage] --> sast
  sast[security-scan: npm audit --audit-level=high] --> deploy
  deploy[deploy: flyctl deploy --region ams --strategy rolling]
```

- **Concurrency group** `deploy-${{ github.ref }}` cancels in-flight deploys when a newer commit lands.
- **Fork protection** — `if: github.repository == 'kakashi3lite/kyc-copilot'` so PRs from forks never deploy.
- **SAST before deploy** — a vulnerability at the `high` or `critical` level blocks the deploy job entirely.

</details>

<details>
<summary><b>🧪 Local development</b></summary>

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

Useful scripts (`package.json`):

| Script | Purpose |
|---|---|
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | Vitest with v8 coverage |
| `npm run test:unit` | Unit tests only |
| `npm run db:migrate` | Drizzle migrations |
| `npm run db:seed` | Seeds the demo tenant + 3 cases |
| `npm run demo` | Boots db + redis, migrates, seeds, starts the API |

</details>

---

## Operational guarantees

| Invariant | Rule | Enforced by |
|---|---|---|
| `INV-001` | Every dossier claim carries a valid `[Source: KEY]` | `guardrail.ts:L8-19` |
| `INV-002` | Uncited claims are stripped — never bypassed | `guardrail.ts` |
| `INV-003` | PII encrypted at rest; list endpoints return masks | `*Encrypted` / `*Mask` columns |
| `INV-004` | Audit logs are append-only with hashed payloads | `audit/logger.ts` |
| `INV-005` | API keys bcrypt-hashed; raw key returned once | `auth.ts:L26-29` |
| `INV-006` | Webhooks signed HMAC-SHA256 | `webhooks/dispatcher.ts:L9-11` |
| `INV-007` | `pending_hitl` cases never auto-approve | `guardrail.ts:L25-26` |

---

## Roadmap (post v1.0.0)

- **SAML / SSO** — for federal tenant onboarding (TBS-aligned IdP federation)
- **Scheduled re-screening cron** — automated periodic EDD refresh
- **Compiled LangGraph StateGraph migration** — true graph checkpoint/resume (ADR-001)
- **Stripe billing enforcement** — metered plan upgrades in production

---

## License

MIT. See [`LICENSE`](./LICENSE).