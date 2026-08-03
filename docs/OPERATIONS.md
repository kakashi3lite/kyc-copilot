# OPERATIONS — Running, Deploying, and Operating KYC Copilot

> The operator's runbook. Covers local dev, the docker-compose stack, Fly.io
> deployment, migrations, health, observability, and the known operational
> quirks of this codebase (updated 2026-08-04).

---

## 1. Quick reference

```bash
npm run dev              # tsx watch → http://localhost:3000
npm run typecheck        # strict TypeScript
npm run test             # vitest + coverage (thresholds: 60% lines / 40% branches)
npm run build            # tsc -p tsconfig.build.json → dist/
npm start                # node dist/src/index.js
npm run db:generate      # new migration from schema
npm run db:migrate       # apply migrations
npm run db:seed          # demo tenant + plans + cases (idempotent)
npm run demo             # docker compose up postgres redis → migrate → seed → dev
docker compose run --rm test   # full suite against real Postgres + Redis
```

---

## 2. Local environment

The local stack uses Docker for Postgres + Redis (see `docker-compose.yml`):

```bash
docker compose up -d postgres redis
npm run db:migrate && npm run db:seed
LLM_TIER_PRIMARY=t0 npm run dev
```

| Service | Default | Notes |
|---|---|---|
| App | `http://localhost:3000` | `LLM_TIER_PRIMARY=t0` gives deterministic, offline verdicts |
| Postgres | `localhost:5432` | `postgres://kyc:kyc@localhost:5432/kyc` |
| Redis | `localhost:6379` | Queues, rate limits, PDF cache |

**Quirks (verified):**

- `db:seed` writes its data and then appears to hang — the pg pool keeps the
  process alive. Kill it after the JSON output prints; the data is committed.
- If `:3000` is already in use, a previous dev server may have survived its
  terminal: `lsof -iTCP:3000 -sTCP:LISTEN` and kill the stray PID.
- The E2E suite boots its own server on `:3100`. If a killed test run leaves a
  zombie listener, requests hang forever — check `lsof -iTCP:3100`.

---

## 3. Docker / compose stack

`docker-compose.yml` runs: `app` (build from `Dockerfile`), `postgres:16`,
`redis:7`, `minio`, `mailpit`, and a `test` service that runs the full suite
(including the real E2E lifecycle) against the stack.

```bash
docker compose up --build
docker compose run --rm test          # CI-style test run
```

The `test` service is the canonical way to prove a change is green against real
infrastructure before deploying.

---

## 4. Deploying to Fly.io

Primary region `ams` (Amsterdam) for EU data residency; release command runs
migrations automatically; HTTPS forced; `/health` is the readiness probe.

```bash
# 1. Set production secrets (generates fresh ENCRYPTION/JWT/REPORT_SIGNING keys)
bash infra/fly-secrets.sh

# 2. Deploy
fly deploy

# 3. Verify
fly status
fly logs --app kyc-copilot
```

`infra/fly-secrets.sh` is idempotent and generates a fresh
`REPORT_SIGNING_KEY` each run — rerun it only at first setup, or rotate the
report key deliberately (old reports lose verification).

### WAF

`infra/cloudflare-waf.tf` provisions Cloudflare WAF rules. Apply via
`terraform -chdir=infra apply`.

---

## 5. Migrations

- Migrations are Drizzle-generated snapshots in `src/db/migrations/`
  (`0000_initial` → `0002_billing_mvp`).
- `db:generate` diffs `src/db/schema.ts` against the last snapshot and emits a
  new numbered migration + journal entry. Hand-written SQL migrations must also
  update `meta/_journal.json` and add a snapshot — prefer `db:generate`.
- Production applies them via the Fly release command
  (`node dist/src/db/migrate.js`) **before** traffic shifts.
- `0002_billing_mvp` seeds the `plans` table (Starter/Growth/Enterprise) —
  required for quota enforcement and the billing tab.

---

## 6. Health & observability

| Endpoint | Purpose |
|---|---|
| `GET /health` | Readiness — checks Postgres + Redis connectivity |
| `GET /` | Landing page |
| `GET /app` | Dashboard (auth-gated client-side) |

- Structured logs via `pino` (`LOG_LEVEL` env). Request context (request id,
  tenant id, case id) is attached via `AsyncLocalStorage`.
- PII is masked in log output (`maskPiiInText`) and redacted (`redact.paths`).
- **No metrics/OTel exporter is wired yet** — `OTEL_ENABLED` is a placeholder.
  For production observability, export pino to your collector and add Fly
  metrics before scaling.

---

## 7. Known operational notes

| Area | Note |
|---|---|
| Billing | With no `STRIPE_SECRET_KEY`, billing is disabled but the app keeps running; the plan gate skips subscription enforcement (fail-soft). Configure Stripe + webhook secret to enforce. |
| Reports | Without `REPORT_SIGNING_KEY`, reports are signed as `unsigned:<sha256>` (tamper-evident but not authenticated). Set the key in production. |
| Browser pool | Playwright uses a dual-semaphore shared pool — `soft_limit 20 / hard_limit 50` on Fly protects it. PDF renders can `PoolTimeoutError` (→ 503) under saturation; retry. |
| LLM | `LLM_TIER_PRIMARY` selects the default tier. `t0` is the deterministic/offline tier used by tests and the demo. `LLM_SYNC_ALLOWED_TIERS` controls which tiers may run synchronously (`POST /cases?sync=true`). |
| S3 | `S3_*` env vars exist and MinIO runs in compose, but **no S3 code is wired** — evidence lives in Postgres. |
| Email | `RESEND_API_KEY` + `EmailService` are stubs; password-reset links are logged in dev. Wire Resend before relying on email in production. |
| SSE | `GET /cases/stream` emits a single snapshot then closes (not live streaming). |

---

## 8. Graceful shutdown

On `SIGTERM`/`SIGINT` the app: stops accepting HTTP → closes the BullMQ worker
→ closes the webhook deliverer → closes the graph queue, browser pool, Redis,
and Postgres. Fly's `kill_signal = "SIGTERM"` + `kill_timeout = "10s"` gives it
room to finish in-flight requests.
