# DECISIONS — Architecture Decision Records

> TL;DR: Do not reverse an Accepted ADR without writing a new ADR that supersedes it.

Format: Context → Decision → Consequences → Do not undo unless → Alternatives rejected.

---

## ADR-001: Imperative KycGraph over compiled StateGraph

- **Status:** Accepted
- **Context:** LangGraph StateGraph was used in v0 prototype. v1 needed explicit per-node timeouts, simpler test injection, and typed dependency wiring without generic inference issues.
- **Decision:** Use imperative `KycGraph.run()` in `src/graph/graph.ts` that calls nodes sequentially with `withTimeout()`.
- **Consequences:**
  - Easier unit testing with mocked dependencies
  - Explicit timeout per node (5s–60s)
  - `PostgresSaver` exported but not wired into run path
  - HITL cannot use `interruptBefore` — handled externally
- **Do not undo unless:** HITL resume/checkpoint requirements demand graph-level interrupts.
- **Alternatives rejected:**
  - Compiled LangGraph StateGraph (TypeScript generic inference issues in v0)
  - Event-sourced saga pattern (over-engineered for current scale)

---

## ADR-002: HITL as API pause, not graph interrupt

- **Status:** Accepted
- **Context:** High-risk cases need human sign-off. Guardrail sets `status: pending_hitl` and `requiresHuman: true`.
- **Decision:** Graph ends at guardrail. Human approves via `POST /cases/:id/approve`. `humanReviewNode` exists but is not in `KycGraph.run()`.
- **Consequences:**
  - Case row is source of truth for HITL state
  - Approve endpoint updates status, writes audit log, fires webhook
  - No graph resume from checkpoint needed today
- **Do not undo unless:** Mid-graph pause/resume with partial state becomes a requirement.
- **Alternatives rejected:**
  - LangGraph `interruptBefore: ["humanReviewNode"]` (v0 approach, dropped in v1)
  - Auto-approve with confidence threshold (violates INV-007)

---

## ADR-003: PII encrypt + mask pattern

- **Status:** Accepted
- **Context:** GDPR requires protecting PII in list views while allowing full decrypt in detail/worker paths.
- **Decision:** Store `*Encrypted` (AES-256-GCM) + `*Mask` (redacted display) columns. Lists return masks only; detail endpoints decrypt.
- **Consequences:**
  - `encryptPii`/`decryptPii` in `src/services/encryption/at-rest.ts`
  - Every PII field needs both columns in schema
  - Export endpoint decrypts for GDPR portability
- **Do not undo unless:** Field-level encryption moves to database-native TDE with column policies.
- **Alternatives rejected:**
  - Plaintext storage with access logging (insufficient for GDPR list safety)
  - Tokenization service (adds external dependency)

---

## ADR-004: BullMQ async default, sync for dev

- **Status:** Accepted
- **Context:** Graph execution takes 14s–60s. Blocking HTTP responses degrade API UX.
- **Decision:** `POST /cases` enqueues to `kyc-graph` queue by default. `?sync=true` runs inline for dev/testing.
- **Consequences:**
  - `graph-runner.ts` worker with concurrency 10
  - Failed jobs go to `failed_cases` table
  - 3 retry attempts with exponential backoff
- **Do not undo unless:** Latency requirements demand synchronous-only API.
- **Alternatives rejected:**
  - Always synchronous (blocks API under load)
  - Separate microservice for graph (premature split)

---

## ADR-005: Evidence hash chain in DB

- **Status:** Accepted
- **Context:** EU auditors require chain-of-custody for CDD/EDD findings.
- **Decision:** `evidence` table stores `contentHash` + optional `previousHash`. Audit logs hash each event payload.
- **Consequences:**
  - Evidence rows are append-only (unique key per case)
  - Guardrail validates `[Source: KEY]` against ledger keys
  - Reports include full evidence chain
- **Do not undo unless:** Blockchain-based attestation is adopted.
- **Alternatives rejected:**
  - In-memory evidence map (lost on restart, v0 approach)
  - File-only evidence store without DB index

---

## ADR-006: Vanilla HTML dashboard (no React)

- **Status:** Accepted
- **Context:** Dashboard is a demo/product shell, not a complex SPA. Zero build step reduces deployment friction.
- **Decision:** `public/landing.html` (marketing) + `public/app.html` (dashboard). Pure CSS/JS, no bundler.
- **Consequences:**
  - 5 UX upgrades implemented in vanilla JS (toasts, skeletons, ceremony, transitions, empty states)
  - Served directly by Hono `readFileSync`
  - No hot module replacement in dev
- **Do not undo unless:** Dashboard complexity demands component library (tables with 10k rows, real-time collaboration).
- **Alternatives rejected:**
  - React/Next.js frontend (build step, deployment complexity)
  - HTMX partial updates (still needs server templates)

---

## ADR-007: Zod everywhere for LLM outputs

- **Status:** Accepted
- **Context:** LLM hallucinations in routing/extraction are a compliance risk.
- **Decision:** All LLM decisions forced through Zod schemas via `.parse()`. Schemas in `src/graph/schemas.ts`.
- **Consequences:**
  - `EntityInputSchema`, `ApiCompanyDataSchema`, `DossierSchema` validate all structured outputs
  - Parse failures throw and route to `failed_cases`
  - No free-form LLM routing decisions
- **Do not undo unless:** Schema validation moves to a dedicated policy engine.
- **Alternatives rejected:**
  - Prompt-only JSON enforcement (unreliable)
  - Legacy LangChain `LLMChain` / `AgentExecutor` (deprecated constructs)

---

## ADR-008: Brand experience as separate static pages

- **Status:** Accepted
- **Context:** Product needs marketing landing page separate from authenticated dashboard.
- **Decision:** `GET /` → `landing.html`, `GET /app` → `app.html`. Marketing has ROI calculator, animated pipeline, pricing.
- **Consequences:**
  - Clear conversion funnel: landing → CTA → `/app`
  - Brand tokens: cinematic dark, electric blue, emerald approvals
  - No shared component library between pages
- **Do not undo unless:** Unified design system with shared components is built.
- **Alternatives rejected:**
  - Single `index.html` for both (conflates marketing and product)
  - External marketing site (deployment split)

---

## ADR-009: Plan-gated features (webhooks, rescreen)

- **Status:** Accepted
- **Context:** Commercial tiers need feature differentiation beyond case volume.
- **Decision:** Webhooks and rescreen require `growth` or `enterprise` plan. Checked in route handlers.
- **Consequences:**
  - `src/api/routes/webhooks.ts:L17` — 403 for starter
  - `src/api/routes/cases.ts:L109` — 403 for starter rescreen
  - Plan stored on `tenants.plan` enum
- **Do not undo unless:** All features become plan-agnostic with volume-only billing.
- **Alternatives rejected:**
  - Feature flags service (over-engineered for 3 tiers)
  - Hard-coded tenant allowlists
