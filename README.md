# KYC-Copilot

KYC-Copilot is an agentic AML/KYC compliance platform for EU payments institutions. It replaces manual corporate onboarding dossiers with a 14-minute evidence-backed pipeline that ingests entity data, performs registry and screening lookups, drafts an AMLD6-aligned enhanced due diligence dossier, enforces mechanical citation guardrails, pauses for human approval when required, and emits immutable JSON/PDF compliance reports.

## Product Contract

- Accepts a corporate entity: legal name, registration number, and ISO-2 jurisdiction.
- Fetches structured data from OpenCorporates and ComplyAdvantage through retrying HTTP clients with circuit breakers.
- Falls back to a Playwright browser agent with proxy and user-agent rotation when API data is incomplete.
- Requires every dossier claim to include a valid `[Source: KEY]` evidence citation.
- Strips uncited or invalidly cited claims during guardrail review.
- Pauses for human-in-the-loop approval when risk is high, UBO verification is missing, or browser fallback fails.
- Generates branded compliance reports with AMLD6 article references, audit trail, evidence chain, and digital signature placeholder.
- Dispatches HMAC-SHA256 signed webhooks with exponential backoff.
- Tracks tenant usage for billing and ROI reporting.

## Architecture

```text
Client/API
  -> Hono middleware: request ID, secure headers, CORS, auth, rate limits, RFC 7807 errors
  -> PostgreSQL: tenants, users, cases, evidence, audit logs, usage, webhooks, failures
  -> BullMQ: async KYC graph jobs and webhook delivery jobs
  -> Graph pipeline: ingest -> API lookup -> browser fallback -> dossier -> guardrail -> HITL/report
  -> Reports: JSON + Puppeteer-rendered PDF
```

Business state is persisted in PostgreSQL. Redis is used only for rate limiting and queues. PII fields are encrypted with AES-256-GCM before database writes and masked before logging or dashboard list output.

## Source Layout

```text
src/config/                 environment validation and Pino logging
src/db/                     Drizzle schema, database pool, migration, seed
src/graph/                  typed agent state, lifecycle nodes, graph runner
src/services/kyc-data/      OpenCorporates and ComplyAdvantage clients
src/services/browser/       Playwright fallback, proxy rotation, registry map
src/services/llm/           deterministic structured dossier drafting and fallback hooks
src/services/billing/       Stripe adapter and usage metering
src/services/reports/       JSON report generation and PDF rendering
src/services/webhooks/      HMAC dispatcher and delivery worker
src/services/audit/         immutable audit log writer
src/services/encryption/    AES-256-GCM PII encryption
src/api/                    Hono middleware, routes, app assembly
src/workers/                BullMQ graph and webhook workers
public/                     landing page and dashboard
/tests/                     unit, integration, e2e, and fixtures
```

## API Surface

Public routes:

- `GET /health` — liveness with DB, Redis, and OpenAI checks.
- `GET /ready` — readiness, returns `503` if a dependency is unavailable.
- `GET /` — landing page.
- `GET /app` — dashboard shell.
- `POST /provision` — creates a tenant, admin user, and one API key. The raw API key is returned once.
- `POST /auth/login` — returns 15-minute JWT access token and 7-day refresh token.
- `POST /auth/refresh` — rotates refresh token.

Authenticated routes:

- `POST /cases` — creates a KYC case and queues graph execution.
- `GET /cases` — lists masked tenant cases.
- `GET /cases/stream` — server-sent snapshot for dashboard updates.
- `GET /cases/export` — GDPR portability export.
- `GET /cases/:id` — case detail, graph state, evidence, and audit trail.
- `POST /cases/:id/approve` — completes HITL review.
- `POST /cases/:id/rescreen` — triggers a new run for Growth and Enterprise tenants.
- `GET /cases/:id/report?format=json|pdf` — downloads compliance report.
- `DELETE /cases/:id/erase` — GDPR hard delete.
- `GET /dashboard` — aggregate metrics and recent cases.
- `GET /usage` — monthly usage and ROI metrics.
- `POST /webhooks` — registers a tenant webhook endpoint.
- `GET /webhooks` — lists webhook endpoints without secrets.
- `POST /webhooks/:id/test` — queues a signed test event.

Admin routes:

- `GET /tenants`
- `GET /tenants/:id/usage`
- `POST /tenants/:id/plan`

## Security Controls

- API keys are bcrypt-hashed and never stored in plaintext.
- JWT access tokens expire after 15 minutes; refresh tokens expire after 7 days and rotate on use.
- `registrationNumber`, company names, webhook secrets, and evidence source URLs are encrypted at rest with AES-256-GCM.
- Pino structured logging masks PII and redacts secrets.
- Redis-backed rate limits enforce tenant API limits and stricter auth IP limits.
- Secure headers include `X-Frame-Options`, HSTS, and CSP.
- Inputs are normalized with Unicode NFKC and HTML/script injection patterns are stripped.
- External clients use retries, timeouts, and circuit breakers.
- Failed cases are persisted in `failed_cases` for manual review.

## Local Development

### Prerequisites

- Node.js 20+
- Docker and Docker Compose
- PostgreSQL 16 and Redis 7 when not using Docker Compose

### Configure

```bash
cp .env.example .env
```

Set production-grade secrets before deployment:

```text
ENCRYPTION_KEY=<32-byte hex key>
JWT_SECRET=<strong access-token secret>
JWT_REFRESH_SECRET=<strong refresh-token secret>
DATABASE_URL=postgres://...
REDIS_URL=redis://...
```

### Install and verify

```bash
npm install
npm run typecheck
npm run test
```

### Run the full local stack

```bash
docker compose up --build
```

The app listens on `http://localhost:3000`. PostgreSQL, Redis, MinIO, and Mailpit are included in `docker-compose.yml` for local development.

## Example Lifecycle

Provision a tenant:

```bash
curl -X POST http://localhost:3000/provision \
  -H 'Content-Type: application/json' \
  -d '{"name":"Demo Payments BV","email":"admin@example.test","password":"ChangeMe-123456","plan":"growth"}'
```

Create a case:

```bash
curl -X POST 'http://localhost:3000/cases?sync=true' \
  -H 'Authorization: Bearer kc_live_REPLACE_WITH_RETURNED_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"companyName":"Test BV","registrationNumber":"12345678","jurisdiction":"NL"}'
```

Download a PDF report:

```bash
curl 'http://localhost:3000/cases/<caseId>/report?format=pdf' \
  -H 'Authorization: Bearer kc_live_REPLACE_WITH_RETURNED_KEY' \
  -o report.pdf
```

## Compliance Model

Reports cite AMLD6 article records stored in PostgreSQL with effective dates. Every claim in the dossier must cite a key in the evidence ledger. The guardrail node mechanically removes claims without valid evidence. Audit logs are append-only and hash each event payload for chain-of-custody review.

## Validation Status

The codebase is designed for strict TypeScript with `noUncheckedIndexedAccess` and ESM `NodeNext` imports. In this environment, npm registry access is blocked by DNS resolution failures (`ENOTFOUND registry.npmjs.org`), so dependency installation, `npm run typecheck`, and `npm run test` could not be completed locally. Run the verification commands above from a network-enabled environment before release.

## License

MIT. See `LICENSE` if present in the repository root.
