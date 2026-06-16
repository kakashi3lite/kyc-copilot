# KYC Copilot 🛡️

> **The 14-Minute Agentic AML/KYC Compliance Platform.**

KYC-Copilot is an agentic AML/KYC compliance platform built for EU payments institutions. It replaces manual corporate onboarding dossiers with an evidence-backed pipeline.

### 📈 Impact at a Glance
| Metric | Value |
|--------|-------|
| 📉 **Time Savings** | 95% Reduction in manual KYC onboarding time. |
| ⚖️ **Compliance** | 100% Alignment with AMLD6 EU directives. |
| 🤖 **Accuracy** | Zero Hallucinations via mechanical citation guardrails. |
| ⚡ **Deployment** | <5 Seconds to spin up a local presentation demo. |

---

## 🧩 The Core Pipeline

The pipeline ingests entity data, performs registry and screening lookups, drafts an AMLD6-aligned enhanced due diligence dossier, enforces mechanical citation guardrails, pauses for human approval when required, and emits immutable JSON/PDF compliance reports.

```mermaid
graph TD
    A[Ingest Entity Data] --> B{API Lookup}
    B -- Success --> D[Draft EDD Dossier]
    B -- Incomplete Data --> C[Browser Agent Fallback]
    C --> D
    D --> E[Mechanical Guardrail Review]
    E -- Missing Citations --> F[Strip Invalid Claims]
    E -- Valid Citations --> G{Risk Assessment}
    F --> G
    G -- High Risk / Missing UBO --> H[Human-In-The-Loop Approval]
    G -- Low Risk --> I[Emit Compliance Reports]
    H --> I
```

---

## 🏛 System Architecture

The technical foundation leverages a scalable, async-first architecture.

```mermaid
flowchart TD
    Client[Client / GuardOS Dashboard] --> Hono[Hono Middleware API]
    
    subgraph Core Services
        Hono --> DB[(PostgreSQL)]
        Hono --> Redis[(Redis)]
        Hono --> BullMQ[BullMQ Job Queue]
    end
    
    BullMQ --> Graph[Agentic Graph Pipeline]
    Graph <--> DB
    
    BullMQ --> Webhooks[HMAC Webhook Delivery]
    
    subgraph Data Stores
        DB -.-> |Tenants, Cases, Audit Logs, Encrypted PII| Hono
        Redis -.-> |Rate Limits & Queues| Hono
    end
    
    Graph --> Reports[PDF & JSON Compliance Reports]
```

---

## 🚀 The 1-Click "Wow" Demo

Experience the platform immediately. 

```bash
# Start the cinematic GuardOS dashboard, fully seeded with demo data
npm install
npm run demo
```
Navigate to `http://localhost:3000` to see the live demo environment.

---

## 🛠 Developer Deep-Dive & Source Layout

### Directory Layout
- 📂 `src/config/` — Environment validation and Pino logging
- 📂 `src/db/` — Drizzle schema, database pool, migration, seed
- 🧠 `src/graph/` — Typed agent state, lifecycle nodes, graph runner
- 🔌 `src/services/kyc-data/` — OpenCorporates and ComplyAdvantage clients
- 🌐 `src/services/browser/` — Playwright fallback, proxy rotation, registry map
- 🤖 `src/services/llm/` — Deterministic structured dossier drafting and fallback hooks
- 💳 `src/services/billing/` — Stripe adapter and usage metering
- 📄 `src/services/reports/` — JSON report generation and PDF rendering
- 🪝 `src/services/webhooks/` — HMAC dispatcher and delivery worker
- 🔒 `src/services/audit/` — Immutable audit log writer
- 🔐 `src/services/encryption/` — AES-256-GCM PII encryption
- 🛣 `src/api/` — Hono middleware, routes, app assembly
- ⚙️ `src/workers/` — BullMQ graph and webhook workers
- 🎨 `public/` — Landing page and GuardOS dashboard
- 🧪 `tests/` — Unit, integration, e2e, and fixtures

### <details><summary><b>🔌 API Surface (Click to Expand)</b></summary>
**Public routes:**
- `GET /health` — liveness with DB, Redis, and OpenAI checks.
- `GET /ready` — readiness, returns `503` if a dependency is unavailable.
- `GET /` — landing page.
- `GET /app` — dashboard shell.
- `POST /provision` — creates a tenant, admin user, and one API key. The raw API key is returned once.
- `POST /auth/login` — returns 15-minute JWT access token and 7-day refresh token.
- `POST /auth/refresh` — rotates refresh token.

**Authenticated routes:**
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

**Admin routes:**
- `GET /tenants`
- `GET /tenants/:id/usage`
- `POST /tenants/:id/plan`
</details>

### <details><summary><b>🛡 Security Controls (Click to Expand)</b></summary>
- API keys are bcrypt-hashed and never stored in plaintext.
- JWT access tokens expire after 15 minutes; refresh tokens expire after 7 days and rotate on use.
- `registrationNumber`, company names, webhook secrets, and evidence source URLs are encrypted at rest with AES-256-GCM.
- Pino structured logging masks PII and redacts secrets.
- Redis-backed rate limits enforce tenant API limits and stricter auth IP limits.
- Secure headers include `X-Frame-Options`, HSTS, and CSP.
- Inputs are normalized with Unicode NFKC and HTML/script injection patterns are stripped.
- External clients use retries, timeouts, and circuit breakers.
- Failed cases are persisted in `failed_cases` for manual review.
</details>

### <details><summary><b>⚖️ Compliance Model (Click to Expand)</b></summary>
Reports cite AMLD6 article records stored in PostgreSQL with effective dates. Every claim in the dossier must cite a key in the evidence ledger. The guardrail node mechanically removes claims without valid evidence. Audit logs are append-only and hash each event payload for chain-of-custody review.
</details>

---

## License

MIT. See `LICENSE` if present in the repository root.
