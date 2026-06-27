# KYC Copilot

> **Agentic AML/KYC compliance engine.**
> O(1) timing-safe auth · atomic Lua rate-limit · citation-backed dossiers · dual-semaphore Playwright.

[![Node 20+](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![Region: ams (EU)](https://img.shields.io/badge/region-ams%20%28EU%29-0A66C2)](./fly.toml)
[![CI: parallel · SBOM · SAST](https://img.shields.io/badge/CI-parallel%20%C2%B7%20SBOM%20%C2%B7%20SAST-success)](./.github/workflows/deploy.yml)

A production-grade compliance pipeline built around three opinions:

1. **Every claim is cited, or it doesn't ship.** The dossier guardrail strips any LLM output that isn't backed by an entry in the immutable evidence ledger.
2. **High-risk decisions are never automatic.** Cases flagged for enhanced due diligence lock at `pending_hitl` until a named analyst signs off — there is no path around it.
3. **Hot paths are O(1) and constant-time.** Auth, rate-limit, and the graph pipeline never do an N-scan or leak timing.

---

## Engineering highlights

The interesting parts of this codebase, with the actual code shape:

### O(1) auth from an O(N)·bcrypt scan

`kc_live_*` API keys used to be matched by iterating every tenant and running bcrypt per row (~100 ms × N). Now the lookup is a single index hit plus a constant-time digest compare.

```ts
// src/api/middleware/auth.ts
export function deriveApiKeyId(rawKey: string): string {
  // First 8 bytes of HMAC-SHA256 — enough to discriminate tenants with
  // negligible collision risk, narrow enough for a unique index.
  const full = createHmac("sha256", LOOKUP_SECRET).update(rawKey).digest();
  return full.subarray(0, 8).toString("hex");
}

// Hot path: 1 index hit + 1 timingSafeEqual. No bcrypt, no loop.
const tenant = await db.select().from(tenants)
  .where(eq(tenants.apiKeyId, deriveApiKeyId(rawKey))).limit(1);
if (!safeEqualHexDigest(tenant.apiKeyHash, deriveApiKeyHash(rawKey))) {
  return problem(c, 401, "Unauthorized", "Invalid API key");
}
```

`safeEqualHexDigest` defends against the `crypto.timingSafeEqual` length-mismatch throw (which would otherwise leak via the 500 path) by validating 64-char hex *before* the comparison.

### Atomic Redis rate-limit, one round-trip

The previous limiter did `INCR` then `EXPIRE` separately — two round-trips and a race window where a crashed process leaves a TTL-less bucket forever. Now a Lua script does `INCR + EXPIRE-if-new + TTL` atomically on the Redis server, registered once via `defineCommand` so subsequent calls are EVALSHA (~0.3 ms):

```ts
// src/api/middleware/rate-limit.ts
const RATE_LIMIT_LUA = `
  local current = redis.call('INCR', KEYS[1])
  if current == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
  local ttl = redis.call('TTL', KEYS[1])
  local limit = tonumber(ARGV[1])
  return {current, limit, math.max(0, limit - current), ttl}
`;
redis.defineCommand("rateLimitAtomic", { numberOfKeys: 1, lua: RATE_LIMIT_LUA });
```

### Shared Chromium, two independent semaphores

A single long-lived Playwright process serves both the graph's browser-fallback node and the PDF renderer. Without partitioning, a flood of PDF downloads would block the screening pipeline. Two semaphores on the same process prevent that:

```ts
// src/services/browser/pool.ts
this.browserFallbackSemaphore = new Semaphore("browserFallback", 8, 30_000);
this.pdfRenderSemaphore       = new Semaphore("pdfRender",       2, 30_000);
```

Each consumer calls the relevant `acquireXxxPermit()` / `releaseXxxPermit()`. A saturated pool returns `PoolTimeoutError` after 30 s; callers are expected to degrade (HITL escalation for the browser path, 503 for the PDF path).

### Mechanical citation guardrail (no LLM hallucinations in the dossier)

The guardrail node strips every claim that doesn't reference a `[Source: KEY]` present in the evidence ledger:

```ts
// src/graph/nodes/guardrail.ts (excerpt)
for (const claim of state.claims) {
  if (!state.evidenceLedger[claim.sourceKey]) {
    state.claims = state.claims.filter((c) => c.id !== claim.id);
  }
}
```

The output dossier cannot contain a claim without a verifiable source. This is the `INV-001` / `INV-002` invariant — enforced mechanically, not by prompt engineering.

### Dynamic LLM Router with deterministic tier selection

Five tiers (T0 deterministic → T4 GPT-4o). `pickModel()` is a pure function — easy to test, easy to reason about:

```ts
// src/services/llm/router.ts
export function pickModel(ctx: RoutingContext): ProviderConfig {
  if (ctx.nodeRequirement === "strict-zod" && !configured.supportsStrictJson)
    return getProvider("t2");                              // 1. promote
  if (ctx.tokenEstimate > 120_000)
    return getProvider("t3");                              // 2. large context → Gemini Flash
  return configured;                                       // 3. default
}
```

| Tier | Provider | When chosen |
|---|---|---|
| T0 | Deterministic | Default offline fallback; zero cost |
| T1 | Ollama Llama 3 (local) | Data-sovereign deployments |
| T2 | OpenAI gpt-4o-mini | Default cloud; cost-optimized JSON |
| T3 | Gemini 1.5 Flash | Large evidence backlogs (>120 k tokens) |
| T4 | OpenAI gpt-4o | Highest-quality dossiers |

### Zero-cost LLM tests via deterministic mock

CI never hits a real LLM API. `tests/setup/llm-mock.ts` is loaded via `vitest.config.ts → test.setupFiles` and replaces every `@langchain/*` adapter plus the `DynamicLlmRouter` with deterministic stubs. Tier-selection logic still runs (so router tests stay honest); no network call is ever made.

---

## System overview

```mermaid
flowchart LR
  Client[Client / Dashboard] -->|Bearer kc_live_*| Hono[Hono API]
  Hono --> DB[(PostgreSQL)]
  Hono --> Redis[(Redis)]
  Hono -->|queue| BullMQ[BullMQ kyc-graph]
  BullMQ --> Graph[6-node Compliance Pipeline]
  Graph <--> DB
  Graph <--> Playwright[Dual-Semaphore Chromium]
  Graph --> LLM[Dynamic LLM Router T0-T4]
  Graph --> Reports[JSON + PDF Dossiers]
  Hono -->|HMAC| Webhooks[Webhook Delivery]
```

### The 6-node compliance pipeline

| # | Node | Timeout | What it does |
|---|---|---|---|
| 1 | `ingestNode` | 5 s | NFKC normalization — defeats sanitization bypass |
| 2 | `apiLookupNode` (OpenCorporates + ComplyAdvantage) | 30 s | Government registry + sanctions/PEP screening |
| 3 | `browserFallbackNode` (Playwright, conditional) | 60 s | Captures JS-heavy registries the API can't reach |
| 4 | `draftDossierNode` (Dynamic LLM Router) | 30 s | Citation-aware draft; every claim gets `[Source: KEY]` |
| 5 | `guardrailNode` | 30 s | Strips any claim not backed by the evidence ledger |
| 6 | `humanReviewNode` (HITL) | n/a | Mandatory analyst sign-off for High risk / unverified UBO |

`pending_hitl` cases **never** auto-approve — only `POST /cases/:id/approve` clears the gate.

---

## 🚀 Interactive demo — 3 steps

The repo ships with a seeded demo key so you can validate the flow end-to-end without setting up external API credentials.

```bash
npm install --legacy-peer-deps
npm run demo          # boots db + redis, runs migrations + seed, starts the API on :3000
```

### 1. Submit a high-risk entity

```bash
curl -X POST http://localhost:3000/cases \
  -H "Authorization: Bearer kc_live_demo0000000000000000000000" \
  -H "Content-Type: application/json" \
  -d '{"companyName":"Volkov Capital Partners","registrationNumber":"CY98765432","jurisdiction":"CY"}'
```

→ `{"caseId":"case_demo_hitl_0002","status":"queued"}`

### 2. Observe the HITL pause

```bash
curl http://localhost:3000/cases/case_demo_hitl_0002 \
  -H "Authorization: Bearer kc_live_demo0000000000000000000000"
```

→ `status: pending_hitl`, `riskScore: High`, `requiresHuman: true`. The graph detected PEP-adjacent ownership and complex nominee structures; no automated path clears this.

### 3. Approve and download the signed PDF

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

## CI/CD

### Parallel DAG

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

Three early jobs run concurrently. Wall time is `max(checks, security-scan, docker-build)`, not the sum — ~50 % faster than the obvious serial chain.

### CycloneDX SBOM, every push

The `security-scan` job generates `sbom.cdx.json` (CycloneDX 1.6, `--omit dev`) and uploads it as a **90-day artifact**. The SBOM reflects only what the production Dockerfile actually installs.

```bash
npx --yes @cyclonedx/cyclonedx-npm@latest \
  --output-format JSON --output-file sbom.cdx.json \
  --spec-version 1.6 --omit dev
```

### Ephemeral PR environments

Every PR gets a temporary Fly app via `superfly/fly-pr-review-apps@1.2.1`:

- `opened / synchronize` → `deploy-preview` job creates `kyc-copilot-pr-<N>` and deploys
- `closed` → `teardown-preview` job runs `flyctl apps destroy`
- Database isolation: per-PR `PREVIEW_DATABASE_URL` (Neon branch-style) — PR databases never touch production
- URL surfaces in the PR UI via the `environment:` block

### LLM mocking in CI

The setup file replaces every LangChain adapter with deterministic stubs; tests run in milliseconds with zero external calls.

### Required GitHub Secrets

| Required | Recommended |
|---|---|
| `FLY_API_TOKEN`, `FLY_ORG` | `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET` |
| `DATABASE_URL`, `REDIS_URL` | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY` |
| `ENCRYPTION_KEY` | `API_KEY_LOOKUP_SECRET` (defaults to `JWT_SECRET` in dev) |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | `FLY_APP` (default `kyc-copilot`), `FLY_REGION` (default `ams`) |
| | `PREVIEW_DATABASE_URL` (PR ephemeral envs) |

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
| Graceful shutdown | `SIGTERM` → close HTTP server, BullMQ worker, queue, browser pool, Redis, Postgres |

Source: [`fly.toml`](./fly.toml). Deploys are automatic on `push to main` once required GitHub Secrets are set.

</details>

---

## Engineering guarantees

These are mechanically enforced invariants — failure to hold them is a build break, not a guideline:

| ID | Rule | Source |
|---|---|---|
| `INV-001` | Every dossier claim carries a valid `[Source: KEY]` | `src/graph/nodes/guardrail.ts` |
| `INV-002` | Uncited claims are stripped — never bypassed | `src/graph/nodes/guardrail.ts` |
| `INV-003` | PII encrypted at rest; list endpoints return masks | `*Encrypted` / `*Mask` columns |
| `INV-004` | Audit logs are append-only with hashed payloads | `src/services/audit/logger.ts` |
| `INV-005` | API keys HMAC-SHA256 hashed; O(1) lookup via indexable id | `src/api/middleware/auth.ts` |
| `INV-006` | Webhooks signed HMAC-SHA256, timing-safe verified | `src/services/webhooks/dispatcher.ts` |
| `INV-007` | `pending_hitl` cases never auto-approve | `src/graph/nodes/guardrail.ts` |

---

## Roadmap

- Compiled LangGraph StateGraph migration — true graph checkpoint / resume
- SAML / SSO for tenant onboarding
- Scheduled re-screening cron
- Stripe billing enforcement

---

## License

MIT. See [`LICENSE`](./LICENSE).