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

---

## ADR-010: Dynamic Multi-Provider LLM Routing

- **Status:** Accepted
- **Context:** Phase 1 used `DeterministicLlmClient` (rule-based, no LLM call). Production requires real LLM reasoning for complex dossiers while maintaining cost control and avoiding vendor lock-in. Different providers offer different trade-offs: context window size (Gemini 1M), cost (GPT-4o-mini), quality (GPT-4o), and local development (Ollama).
- **Decision:** Implement `DynamicLlmRouter` behind the existing `LlmClient` interface. Five tiers:
  - **T0** — Deterministic (rule-based, $0, always available)
  - **T1** — Ollama/Llama 3 (local, $0, no strict JSON)
  - **T2** — GPT-4o-mini (default prod tier, cheap, strict JSON)
  - **T3** — Gemini 1.5 Flash (1M context, strict JSON, for large inputs)
  - **T4** — GPT-4o (premium, reserved for complex cases)

  Pure function `pickModel()` applies routing rules:
  1. If strict-zod required and tier lacks support → route to T2
  2. If token estimate > 120K → route to T3 (Gemini Flash)
  3. Default → configured tier (env `LLM_TIER_PRIMARY`)

  Sync gate on `POST /cases?sync=true` rejects tiers not in `LLM_SYNC_ALLOWED_TIERS` with HTTP 400 to prevent 504 Gateway Timeouts.
- **Consequences:**
  - Provider catalog in `src/config/llm-providers.ts` is single source of truth
  - Router in `src/services/llm/router.ts` with `pickModel()` pure function
  - LangChain adapters in `src/services/llm/adapters/*.ts` wrap provider SDKs
  - `FallbackLlmClient` delegates to `DynamicLlmRouter` — zero changes to `graph-runner.ts`
  - `AgentState.llmSelection` tracks which provider was selected per run
  - T0 remains automatic fallback when API keys are missing or providers error
- **Do not undo unless:** A dedicated AI gateway (e.g., LiteLLM proxy) replaces in-process routing.
- **Alternatives rejected:**
  - Single-provider hardcoding (vendor lock-in, no cost optimization)
  - External LLM proxy service (adds infrastructure complexity prematurely)
  - Per-node provider selection (over-complicated for current single-LLM-call architecture)

---

## ADR-011: O(1) API-key lookup with HMAC shadow index (placeholder)

> See `docs/PLAN_cost_optimization.md` §4.3 for the draft. Accepted on
> Phase 1 merge; full text added by the IMPLEMENTER session.

---

## ADR-012: Shared Playwright Chromium Pool with Dual-Semaphores

- **Status:** Accepted (2026-06-17)
- **Context:** `PlaywrightBrowserPool` (`src/services/browser/pool.ts`) launched a single Chromium process for the app lifetime but capped at 10 contexts. The hard cap returned `requiresHuman: true` on saturation — silently increasing HITL load and breaking dossier completion SLAs. Concurrently, `Puppeteer` in `src/services/reports/pdf-renderer.ts` launched a *second* Chromium per `GET /cases/:id/report?format=pdf` request — a fresh 300 MB process on every dashboard refresh. The two consumers competed for the same RAM envelope, and a flood of PDF renders could starve the dossier pipeline.
- **Decision:**
  1. **Unify on Playwright.** Drop Puppeteer from `package.json` (saves ~300 MB per concurrent PDF render + removes a separate Chromium download from `npm install`).
  2. **Single long-lived Chromium process** owned by one `PlaywrightBrowserPool` instance, exposed via the `sharedBrowserPool()` module-level singleton so the graph worker and the PDF renderer share the same process.
  3. **Two independent semaphores** partition the 10-context envelope:
     - `browserFallbackSemaphore` — capacity 8, used by `browserFallbackNode` (graph pipeline).
     - `pdfRenderSemaphore` — capacity 2, used by `renderPdf()` (dashboard).
  4. **Bounded queue + timeout.** Each semaphore rejects waiters after 30s with `PoolTimeoutError`. The browser-fallback node catches this and escalates to `requiresHuman: true` (INV-007 compliant — never auto-completes on pool starvation). The PDF renderer propagates the error, which the Hono error handler turns into 500; the client retries.
  5. **PDF result caching.** `renderPdf` computes a content hash from the report's semantic fields (`caseId`, `subject`, `riskScore`, `dossier`, `evidenceChain`, `articleCitations`), looks up `pdf:{caseId}:{hash}` in Redis with a 5-minute TTL, and returns the cached buffer on hit. Cache failures are non-fatal — the render proceeds.
- **Consequences:**
  - One Chromium process per Node process. No more per-request Puppeteer launches.
  - Pool saturation no longer fires `requiresHuman: true` from the hard cap path; it fires only from the new bounded-timeout path, with a precise error.
  - The PDF endpoint sees a 60–80% reduction in render time on dashboard refreshes within the 5-minute cache window (real-world: most dashboards re-render the same case within seconds).
  - `browserFallbackNode` becomes INV-007-strict: a pool timeout always escalates to HITL, never crashes the worker.
  - `PoolTimeoutError` is exported from `src/services/browser/pool.ts`; `pdf-renderer.ts` re-exports it for route-handler convenience.
  - `sharedBrowserPool()` singleton — tests construct their own `PlaywrightBrowserPool` directly to avoid the global.
- **Do not undo unless:** the system is migrated to Browserless.io (or equivalent) self-hosted, in which case the singleton becomes a client to that service.
- **Alternatives rejected:**
  - Browserless.io SaaS — introduces third-party egress of company PII.
  - Two separate Chromium processes (one per consumer) — doubles RAM with no benefit given the 8/2 partition.
  - Hard cap returning `requiresHuman: true` on saturation (old behavior) — silently degrades user experience with no auditable signal.
  - PDF cache keyed on `reportId` — varies per generation, hits 0% of the time; the content-hash approach hits ~80% in dashboard-refresh patterns.

---

## ADR-013: Deterministic KYC data fallback for zero-key operation

- **Status:** Accepted
- **Context:** The MVP demo must run end-to-end **without any external API
  credentials** (OpenCorporates, ComplyAdvantage, LLM providers). Previously a
  keyless run either failed (ComplyAdvantage 401 with no auth header) or forced
  every case to `pending_hitl` (the composite adapter forced
  `completeness: "partial"` because `ubos.length > 0` was always false, and the
  guardrail sent every unverified-UBO case to HITL). That made the zero-key
  story undemonstrable. This ADR mirrors ADR-010 (which guarantees a T0 LLM
  tier is always available) for the registry/screening data side.
- **Decision:**
  1. New `DeterministicKycDataAdapter` (`src/services/kyc-data/deterministic.ts`)
     implements `KycDataAdapter` with **zero network calls**. It echoes the
     input identity fields, reports `completeness: "complete"`, `ubos: []`,
     `status: "active"`, and `sourceUrl: "urn:deterministic:kyc-copilot"`. A
     bundled, jurisdiction-gated high-risk rule set (currently matching the
     seeded demo entity **Volkov Capital Partners / CY**) returns a
     `kyc-copilot-demo` sanctions hit and `pep: true`; everything else is clean.
  2. `CompositeKycDataAdapter` is now **fail-open**: the `Promise.all` of real
     providers is wrapped in try/catch and falls back to the deterministic
     adapter on any throw (401 from a missing key, network error, circuit
     breaker trip). Each real adapter reports its own `completeness`
     truthfully — the composite no longer overrides it.
  3. **HITL trigger relaxation** (guardrail decision table): a case goes to
     `pending_hitl` only on sanctions match, PEP, `riskScore === "High"`,
     Medium with unverified UBO, `completeness === "partial"`, or browser
     failure. **Low + complete now completes even when UBOs were not
     individually verified** — missing UBO rows are a documented limitation of
     the deterministic adapter / deferred officers API, not a fraud signal.
  4. T0 LLM risk scoring (`DeterministicLlmClient`) scores complete,
     non-elevated-jurisdiction data as **Low** even with no UBO rows, so the
     guardrail's Low + complete row actually fires in zero-key mode.
- **Consequences:**
  - `api-lookup.ts` sets `requiresHuman` on sanctions **or PEP** or partial.
  - `edges.ts` skips the browser fallback when `completeness === "complete"` and
    `!requiresHuman` (previously required `uboVerified`).
  - Real adapters take priority; deterministic is used only on the catch path.
  - `approve` route enforces INV-007 atomically: pre-read 404/409 + `WHERE
    status = pending_hitl`.
  - `tests/unit/services/deterministic-kyc.test.ts`,
    `tests/integration/api/cases-keyless.test.ts` cover the fallback and the
    completed/pending_hitl split.
- **Do not undo unless:** a real zero-key-capable data provider replaces the
  deterministic adapter (e.g., a local registry mirror), or UBO extraction via
  the officers API lands and restores `completeness: "complete"` semantics
  with verified UBOs.
- **Alternatives rejected:**
  - Making the deterministic adapter always report `ubos: [verified UBO]` —
    fabricates identity data, unacceptable for compliance.
  - Leaving the unconditional `!uboVerified → HITL` guardrail — every zero-key
    case would pend forever and the demo would not reproduce.

---

## ADR-014: Real UBO extraction from registry officers with soft-degrade

- **Status:** Accepted
- **Context:** The officers API was a documented limitation — `OpenCorporatesClient`
  always returned `ubos: []` and `completeness: "complete"` without ever calling the
  officers endpoint (ADR-013 "Do not undo unless … UBO extraction via the officers
  API lands"). This feature converts that limitation into a genuine CDD capability
  while preserving the zero-key story and the "never fabricate identity data"
  principle.
- **Decision:**
  1. **D1 — Source:** OpenCorporates officers API
     (`GET /companies/{jurisdiction}/{registration}/officers`). First page only
     (max 25 officers) — no pagination chasing in v1.
  2. **D2 — Verified semantics:** an officer is `verified: true` only with a
     non-empty `name` and a `current_status` that is not explicitly
     resigned/inactive/removed. Unnamed and resigned officers are dropped.
  3. **D3 — Ownership honesty:** `ApiCompanyData.ubos[].ownershipPct` widened
     from `number` to `number | null`. `percentage_of_shares` (number or
     numeric string) is used when present; otherwise `null` — never invented.
     Zod schema updated to `.nullable()`.
  4. **D4 — Failure = soft-degrade, NOT every-case-HITL:** if the officers
     fetch throws, times out, trips its breaker, or yields zero valid officers,
     `OpenCorporatesClient.lookup()` returns the company-only record with
     `ubos: []` and `completeness: "complete"`, logging a warning. A documented
     limitation must not re-introduce the old every-case-HITL behavior.
  5. **D5 — Evidence:** a single `API_1` key is retained; its summary gains
     `" · N beneficial owner(s) reported by registry"` when UBOs are present.
     The evidence hash already covers `ubos` (hash over `JSON.stringify(data)`).
  6. **D6 — Zero-key invariant:** `DeterministicKycDataAdapter` is unchanged —
     `completeness: "complete"`, `ubos: []`. Real UBOs come only from the real
     provider.
  7. **D7 — Location:** the officers fetch lives **inside**
     `OpenCorporatesClient.lookup()` (own try/catch + its own
     `CircuitBreaker(5, 30s)` + `withRetry`), not in a separate graph node.
     This keeps the `CompositeKycDataAdapter` fail-open contract intact: only a
     company-lookup failure trips the deterministic fallback; an officers-only
     failure degrades to `ubos: []` without losing real company data.
- **Consequences:**
  - `src/types/index.ts`, `src/graph/schemas.ts` — `ownershipPct` nullable.
  - `src/services/kyc-data/opencorporates.ts` — `fetchOfficers` +
    `fetchOfficersSafe` (soft-degrade wrapper), separate officers breaker.
  - `src/graph/nodes/api-lookup.ts` — evidence summary UBO count; `uboVerified`
    logic unchanged (already correct).
  - Guardrail decision table (ADR-013) unchanged: Medium + verified UBO +
    complete completes; Medium + `!uboVerified` still HITL; officers failure +
    Low still completes.
  - `tests/unit/services/opencorporates-ubo.test.ts` (new), api-lookup unit
    tests extended, fixtures extended.
- **Do not undo unless:** a richer beneficial-ownership source (e.g., a
  corporate-register API with ownership chains) replaces the officers endpoint.
- **Alternatives rejected:**
  - A separate `uboExtractionNode` in the graph — a node failure would crash
    the worker and route to `failed_cases`, losing the soft-degrade property
    and real company data.
  - Guessing ownership from officer role — fabricates data (D3).
  - Pagination chasing across all officers pages — added complexity with
    diminishing returns at this scale.

## ADR-015: JWT dashboard auth replaces the hardcoded demo key

- **Status:** Accepted (Business MVP, 2026-08-04)
- **Context:** `public/app.html` shipped a hardcoded `kc_live_demo...` API key in
  the browser — any visitor could read it and drive the API. The auth system
  already supported JWT issuance (`/auth/login`, `/auth/refresh`); only the UI
  was missing.
- **Decision:**
  1. **D1 — Auth mode:** email/password → 15-minute access JWT + 7-day refresh
     token. Refresh tokens rotate on use and are revoked on password reset.
  2. **D2 — Client:** `public/app.html` now uses a `fetchWithAuth` helper —
     attaches the Bearer token, silently refreshes on 401, redirects to
     `/login.html` when the session can't be recovered. No framework (ADR-006).
  3. **D3 — JWT claims:** access tokens carry `sub`, `tenantId`, `role`, and
     `email` (for the header). The plan badge is fetched from `/billing` — the
     DB is the source of truth, never a possibly-stale token claim.
  4. **D4 — API keys unchanged:** `kc_live_*` keys remain for machine-to-machine
     (O(1) HMAC lookup, ADR-011). They are never rendered into the browser.
  5. **D5 — Password reset:** `POST /auth/forgot-password` stores a SHA-256
     reset-token hash (1 h expiry) and always returns 200 (no account
     enumeration); `POST /auth/reset-password` updates the password and revokes
     all sessions. Emails are logged in dev until Resend is wired.
- **Consequences:** new `public/{login,signup,forgot-password,reset-password}.html`;
  self-serve provision (`POST /provision`) creates tenant + user + Stripe
  customer + Checkout in one flow (duplicate email → 409).
- **Do not undo unless:** a full IdP (SAML/OIDC) replaces email/password.

## ADR-016: Stripe Checkout + Customer Portal for subscription billing

- **Status:** Accepted (Business MVP, 2026-08-04)
- **Context:** The product was pre-revenue. `StripeBillingClient` had a real
  `createCustomer()` and a no-op `recordUsage()`; nothing created subscriptions
  or enforced plans. Building a billing engine in-house would be PCI-heavy and
  slow.
- **Decision:**
  1. **D1 — Stripe owns the lifecycle:** hosted Checkout (subscriptions), the
     Customer Portal (self-serve plan changes/invoices), and dunning. We sync
     state to Postgres via **signed, idempotent webhooks** (event id is the
     `stripe_events` PK; `checkout.session.completed`,
     `customer.subscription.updated/deleted`, `invoice.paid/payment_failed`).
  2. **D2 — Webhook route is public but verified:** `POST /stripe/webhook`
     reads the **raw body** (`c.req.text()`) and verifies `Stripe-Signature`
     before anything else — it is registered before any body-consuming
     middleware in `src/api/index.ts`.
  3. **D3 — Self-serve provision:** `POST /provision` creates tenant + user +
     Stripe customer + Checkout session (14-day trial on Starter). `checkoutUrl`
     is null in dev/zero-key mode — the signup page proceeds to `/app` directly.
  4. **D4 — Plan enforcement in middleware:** `requirePlanLimit("cases")` returns
     `402 Payment Required` with `{currentUsage, limit, upgradeUrl}` when the
     monthly quota is exhausted. Subscription-status gating is skipped when
     `STRIPE_SECRET_KEY` is empty (fail-soft — the zero-key demo must not lock
     out).
  5. **D5 — Metered usage:** after each processed case,
     `reportMeteredUsageToStripe` reports an idempotent usage record
     (`case:<caseId>` key). Our `usage` table remains the billing source of
     truth; Stripe is the metering sink.
- **Consequences:** migration `0002_billing_mvp` (plans, stripe_events, tenant
  subscription columns); `src/api/routes/{billing,stripe-webhook}.ts`;
  `src/api/middleware/plan-gate.ts`; billing + team tabs in `app.html`.
- **Do not undo unless:** Stripe becomes unavailable long-term (then switch to
  an alternative PSP behind the same webhook contract).

## ADR-017: HMAC-SHA256 content-integrity report signing (D6)

- **Status:** Accepted (Business MVP, 2026-08-04)
- **Context:** PDF reports displayed a `PKCS#7 signature placeholder: <sha256>`
  string — not a signature. Full PKCS#7 with a CA-issued certificate requires
  HSM/KMS infrastructure that is premature for the MVP and deferred to the
  Enterprise plan.
- **Decision:**
  1. **D1 — Algorithm:** HMAC-SHA256 over a canonical string of the report's
     content fields (`reportId, caseId, tenantId, generatedAt, dossier,
     evidenceChain, auditTrail`), keyed by `REPORT_SIGNING_KEY`.
  2. **D2 — Fields:** the report carries `{algorithm, signature, keyFingerprint,
     canonicalFields, verificationHint}`; the PDF renders a "Report Integrity
     Verification" block (no more placeholder).
  3. **D3 — No key = unsigned, tamper-evident:** without `REPORT_SIGNING_KEY`,
     the signature is `unsigned:<sha256(contentHash)>` — content changes are
     still detectable, but the report is not authenticated. Warnings are logged.
  4. **D4 — Verification endpoint:** `POST /cases/:id/report/verify` recomputes
     and compares the signature, returning `{valid, signature, fingerprint}`.
  5. **D5 — SDK note:** the Stripe SDK's pinned API version
     (`2024-12-18.acacia`) is used as-is — no `as any` version-string cast.
- **Consequences:** `src/services/reports/signer.ts`; `ComplianceReportJson.signature`
  replaces `digitalSignatureBlock`; unit tests cover unsigned + signed paths.
- **Do not undo unless:** enterprise customers require CA-issued PKCS#7 (then
  layer it behind the same `signature` field).
