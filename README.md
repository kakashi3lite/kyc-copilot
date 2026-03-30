# 🛡 KYC Copilot

> **Compliance at the speed of intelligence.**

An agentic AML/KYC Compliance Copilot that replaces 3.5-hour manual dossiers with a 14-minute, AMLD6-compliant, evidence-backed pipeline — built on LangGraph.js, GPT-4o, and Hono.

---

## Why this exists

EU payments institutions spend an average of **€380 and 3.5 hours** per corporate KYC case, manually. KYC Copilot automates 90% of that work while preserving a deterministic, auditor-ready evidence trail for every claim.

---

## Features

| Feature | Description |
|---|---|
| **6-node LangGraph pipeline** | Ingest → API Lookup → Browser Fallback → Draft Dossier → Guardrail → Human Review |
| **Immutable Evidence Ledger** | Every factual claim maps to a source URL or screenshot path |
| **AMLD6-aligned reports** | JSON/Markdown reports referencing the exact EU directive article |
| **Human-in-the-Loop (HITL)** | High-risk cases pause the graph for senior compliance officer sign-off |
| **Guardrail node** | A second LLM audits the draft, stripping any unsourced claims |
| **Multi-tenant API** | Bearer-key auth, per-tenant usage metering, and plan limits |
| **Outbound webhooks** | HMAC-signed event delivery with exponential-backoff retry |
| **Marketing landing page** | ROI calculator, animated pipeline, pricing — all pure CSS/HTML |
| **Product dashboard** | Metrics, case queue, drawer, reports, settings — with toast/skeleton/ceremony UX |

---

## Architecture

```
GET  /          → public/landing.html   (marketing page)
GET  /app       → public/app.html       (product dashboard)

POST /cases     → run the LangGraph pipeline
GET  /cases     → list cases (filterable)
GET  /cases/:id → single case state snapshot
POST /cases/:id/approve   → HITL approval
POST /cases/:id/rescreen  → trigger re-screening
GET  /cases/:id/report    → AMLD6 compliance report
GET  /dashboard → aggregate metrics
GET  /usage     → monthly usage + ROI metrics
POST /webhooks  → register an outbound webhook endpoint
GET  /webhooks  → list webhooks
POST /provision → create a new tenant + API key
GET  /health    → liveness probe
```

### LangGraph pipeline

```
ingestDataNode
  └─► apiLookupNode
        ├─► (data complete) draftDossierNode
        └─► (missing/stale) browserFallbackNode ──► draftDossierNode
                                                         └─► guardrailNode
                                                               ├─► (clean)     END
                                                               └─► (flagged)   humanReviewNode ──► END
```

### Source layout

```
src/
  state.ts       — AgentState interface + LangGraph Annotation channels
  nodes.ts       — 6 pipeline nodes (Zod-validated, lazy LLM init)
  graph.ts       — StateGraph assembly, conditional routing, MemorySaver
  index.ts       — Hono HTTP server + all API endpoints
  auth.ts        — API key management, tenant isolation, plan config
  usage.ts       — Monthly usage metering + ROI metrics
  cases.ts       — In-memory case registry (swap for Postgres in prod)
  reports.ts     — AMLD6-aligned compliance report generator
  webhooks.ts    — Outbound webhook delivery with HMAC-SHA256 signing

public/
  landing.html   — Marketing / brand page (7 sections, pure CSS)
  app.html       — Product dashboard (upgraded with 5 UX layers)
  index.html     — Legacy alias (kept for backward compatibility)
```

---

## Quick start

### Prerequisites

- Node.js ≥ 20
- An OpenAI API key (for live mode; demo mode works without one)

### Install

```bash
git clone https://github.com/kakashi3lite/kyc-copilot.git
cd kyc-copilot
npm install
```

### Run (demo mode — no API key required)

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) for the landing page.  
Open [http://localhost:3000/app](http://localhost:3000/app) for the dashboard.

### Run (live mode — real GPT-4o calls)

```bash
cp .env.example .env
# Add your OPENAI_API_KEY to .env
npm run dev
```

The demo API key pre-loaded in the dashboard is `kc_live_demo0000000000000000000000`.

---

## API usage

### Submit a case

```bash
curl -X POST http://localhost:3000/cases \
  -H "Authorization: Bearer kc_live_demo0000000000000000000000" \
  -H "Content-Type: application/json" \
  -d '{"companyName":"Acme Payments BV","registrationNumber":"34289034","jurisdiction":"NL"}'
```

### Download a compliance report

```bash
curl http://localhost:3000/cases/<caseId>/report \
  -H "Authorization: Bearer kc_live_demo0000000000000000000000"
```

### Approve a HITL case

```bash
curl -X POST http://localhost:3000/cases/<caseId>/approve \
  -H "Authorization: Bearer kc_live_demo0000000000000000000000" \
  -H "Content-Type: application/json" \
  -d '{"riskOverride":"Medium","reviewerNotes":"UBO confirmed via passport."}'
```

---

## Tech stack

| Layer | Technology |
|---|---|
| Orchestration | [LangGraph.js](https://github.com/langchain-ai/langgraphjs) (`@langchain/langgraph`) |
| LLMs | OpenAI GPT-4o via `@langchain/openai` + `.withStructuredOutput()` |
| Validation | [Zod](https://zod.dev) — all LLM outputs are schema-validated |
| Browser agent | [Playwright](https://playwright.dev) + Vision LLM fallback |
| HTTP server | [Hono](https://hono.dev) + `@hono/node-server` |
| Language | TypeScript (strict mode, NodeNext modules) |
| Frontend | Vanilla HTML/CSS/JS — zero runtime dependencies |

---

## Compliance

KYC Copilot is designed to support compliance with:

- **EU AMLD6** (Anti-Money Laundering Directive 6) — report generation cites the applicable article
- **Art. 13** — Customer Due Diligence
- **Art. 13–14** — Enhanced Due Diligence triggers
- **Art. 18** — High-risk third countries

> **Note:** This software is a compliance _tool_, not legal advice. Your institution's MLRO remains responsible for final determinations.

---

## Roadmap

- [ ] PostgreSQL checkpointer (replace in-memory case registry)
- [ ] Stripe billing integration (plan enforcement + overage billing)
- [ ] SSO / SAML support
- [ ] PDF report generation
- [ ] Scheduled re-screening cron jobs
- [ ] Audit log export (CSV / SIEM)

---

## License

MIT — see [LICENSE](LICENSE) for details.
