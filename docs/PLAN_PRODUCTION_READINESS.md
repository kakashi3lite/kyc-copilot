---
repo: kyc-copilot
path: /Users/kakashi3lite/kyc-copilot
doc: PLAN_PRODUCTION_READINESS
title: Production Readiness Plan — Verified Gap Analysis & Phased Execution
status: active — Phases 0–5 shipped (2026-08-13); Phase 1 (crypto hardening) is NEXT
updated: 2026-08-13
scope: Close the gap between "sellable MVP" and "production-grade, DORA/GDPR-defensible, fully tested platform", then unlock Blue Ocean Phases 2–6
authors: Vector/Graph Architect (ML/Data) + RegTech Partner Architect (BD)
related:
  - SHIPPING_STATUS.md
  - ARCHITECTURE_CONTEXT.md
  - DECISIONS.md
  - BLUE_OCEAN_ARCHITECTURE.md
  - PLAN_BLUE_OCEAN_IMPLEMENTATION.md
  - PLAN_SECURITY_HARDENING.md
  - PLAN_UBO_EXTRACTION.md
  - PLAN_WEBHOOK_DLQ_REPLAY.md
  - OPERATIONS.md
  - MARKET_INTELLIGENCE.md
target_agents: [Principal AI Architect, Vector/Graph Architect, ZK/Privacy Guardian, IMPLEMENTER]
---

# Production Readiness Plan — Verified Gap Analysis & Phased Execution

> **Guiding principle:** Every phase ships with tests first, gates second, and a
> one-sentence rollback. "It works" is not a deliverable — a passing gate is.
>
> **What changed since 2026-08-04:** Business MVP (Phases A–G) and Blue Ocean
> Sprints 1–5 are shipped. This plan is the *gap-closing* roadmap: it takes the
> verified state of the repo (not assumptions — every claim below has a file
> reference), lists what still needs to be built, and sequences it in phases so
> that compliance foundations land before features that depend on them.

---

## §Phase Status (2026-08-13)

| Phase | Status | Evidence |
|---|---|---|
| **0** — Compliance & Config Foundation | ✅ Shipped | `src/config/env.ts` fail-closed, `infra/fly-secrets.sh`, `fly.toml`, `._*` hygiene |
| **1** — Cryptographic Hardening (G2, G4–G10, G12) | ▶️ **NEXT** | Execution plan: `docs/PLAN_CRYPTO_HARDENING_EXECUTION.md` (self-contained, no external keys) |
| **2** — Evaluation Infrastructure | ✅ Shipped | golden datasets, harness v2, `test:eval` green |
| **3** — KYTClassifier | ✅ Shipped | `src/services/kyt/*`, ADR-021, macro-F1=1.000/FPR=0.000 |
| **4** — Feature Completion | 🔶 Partial (DLQ done; UBO/S3/Resend/SSE/human-review open) | webhook DLQ + replay shipped (ADR-022) |
| **5** — Operations & Continuous-Evaluation Readiness | ✅ Shipped | `docs/DR_RUNBOOK.md`, `docs/INCIDENT_RUNBOOK.md`, `docs/DPA_PACK.md`, `bench:latency`, `bench:drift`, ADR-023 |
| **6** — Blue Ocean Integrations | ⛔ Gated (BD: QTSP sandbox + design partner) | do not pre-build on guesses |
| Deploy (manual) | ⏸ Gated on `FLY_API_TOKEN` (operator deferred) | `deploy-production` job manual in GitLab |

**Next phase rationale (ADR-024):** deploy, UBO real-key, S3, and Resend all need an
API key; Phase 6 needs BD. Phase 1 is the only remaining phase with zero external
credential dependency — execute it while the deploy key is pending.

---

## §0 — Executive Summary

**What exists:** a sellable Business MVP (self-serve signup, Stripe billing,
JWT dashboard, team management, case lifecycle, HMAC-signed reports, GDPR
erase) plus three AI subsystems shipped in Blue Ocean Sprints 1–5: CostRouter
(tiered routing, budgets, semantic cache), RAGGraphBuilder (15-table Postgres
schema with `graph_entities`/`graph_edges`/`case_entities`, deterministic
entity resolution, cross-case graph prompts), and the evaluation-harness
scaffold. 20 ADRs are logged; coverage gates (60/40/55/60) are enforced and
currently green at 66.6/54.8/68.6/67.7.

**What still needs to be built** (verified gaps, §2): 6 config/compliance
gaps (C1–C6), 9 open cryptographic hardening items (G2, G4–G10, G12), the
deferred KYTClassifier (Sprint 6), missing evaluation golden datasets, 2
draft-ready feature prompts (UBO extraction, webhook DLQ replay), 4 stubs to
finish-or-cut (S3 evidence, Resend email, SSE streaming, human-review wiring),
production ops items (backups/DR drill, incident runbook, sub-processor DPA
pack, load benchmarks, model drift monitoring), and repo hygiene (AppleDouble
`._*` files not git-ignored, ~8 unused deps, missing LICENSE file).

**Sequencing rationale:** compliance configuration first (it is cheap, blocks
every enterprise security questionnaire, and is a precondition for the
privacy claims we sell), evaluation infrastructure second (no model work
without golden datasets), then KYT and feature completion, then ops
readiness, then Blue Ocean integrations gated on BD dependencies (QTSP
sandboxes, transaction-data pilots).

---

## §1 — Verified Current-State Inventory

### 1.1 Shipped capability surface (do not rebuild)

| Area | Evidence |
|---|---|
| Hono API, 14 routes + 6 middlewares, RFC7807 errors | `src/api/routes/*`, `src/api/middleware/*` |
| Imperative `KycGraph` pipeline (5 nodes) + BullMQ worker | `src/graph/graph.ts`, `src/workers/graph-runner.ts` |
| Postgres: 15 tables incl. graph tables; migrations through `0004` | `src/db/schema.ts`, `src/db/migrations/` |
| Billing: Stripe Checkout/Portal/webhooks, metered usage, plan gate | `src/services/billing/*`, `src/api/routes/stripe-webhook.ts` |
| Reports: HMAC-SHA256 content-integrity signing + verify endpoint | `src/services/reports/signer.ts` |
| LLM: 5-tier `PROVIDERS` catalog, dynamic router, difficulty classifier, per-tenant budget, semantic Redis cache, immutable audit trail, PII redaction (G1), XML-tagged prompt-injection defense (G11), tenant-scoped graph queries (G3) | `src/services/llm/*`, `src/services/kyc-data/graph-query.ts` |
| Evaluation harness primitives (F1, tier ratio, cache-hit, cost delta) | `tests/evaluation/harness.ts` |
| E2E lifecycle test (provision → login → case → approve → verify → erase) | `tests/e2e/kyc-lifecycle.test.ts` |

### 1.2 Decision register

ADR-001…ADR-020 in `docs/DECISIONS.md`. Invariants INV-001…INV-007 in
`docs/ARCHITECTURE_CONTEXT.md`. Any new work must not violate: imperative
graph (ADR-001), Zod everywhere (ADR-007), PII encrypt+mask (ADR-003), zero-key
deterministic mode (ADR-013), tenant isolation (ADR-018).

### 1.3 Test estate (verified)

- 61 test files across `tests/{unit,integration,e2e,evaluation,setup,fixtures}`.
- Coverage gates in `vitest.config.ts`: lines 60 / branches 40 / functions 55 /
  statements 60 — **enforced**, currently green.
- LLM mocked globally in CI (`tests/setup/llm-mock.ts`) — no network calls.
- Canonical CI-style gate: `docker compose run --rm test` (real Postgres+Redis).

### 1.4 Infra & config state

| Asset | State | Evidence |
|---|---|---|
| Fly.io `ams` (EU residency), HTTPS forced, release-command migrations | Live | `fly.toml` |
| Secrets injection script (idempotent) | Live but **incomplete** | `infra/fly-secrets.sh` |
| Compose stack: app + test + postgres + redis + minio + mailpit | Live | `docker-compose.yml` |
| WAF as code | Terraform exists, deploy status unverified | `infra/cloudflare-waf.tf` |
| Observability | **Off** (`OTEL_ENABLED=false`) | `src/config/env.ts:120` |
| Backups/DR | Not documented/tested | — |

### 1.5 Explicitly deferred / out of scope (from `SHIPPING_STATUS.md`)

SAML/SSO · scheduled re-screening cron · full PKCS#7/HSM signing · localization ·
localization/i18n · KYT (Sprint 6) · entity-resolution golden dataset.

---

## §2 — Verified Gap Analysis (What Needs to Be Built)

### 2.1 Config & compliance gaps (from deployment audit, 2026-08-12)

| ID | Sev | Gap | Evidence |
|---|---|---|---|
| **C1** | 🔴 | `PII_REDACTION_KEY` never injected in production → falls back to `ENCRYPTION_KEY`, breaking the "MUST be distinct" contract (G1 weakening) | `infra/fly-secrets.sh` §3 omits it; `src/services/llm/pii-redactor.ts:57` |
| **C2** | 🔴 | Fail-open insecure defaults in prod: hardcoded `ENCRYPTION_KEY`, `JWT_SECRET="dev-access-secret-change-me"`, S3 `minioadmin/minioadmin` | `src/config/env.ts:88-107` |
| **C3** | 🟠 | Observability off; no alerting path → cannot meet DORA incident detection | `src/config/env.ts:120` |
| **C4** | 🟠 | No key rotation for `ENCRYPTION_KEY`; rotating `REPORT_SIGNING_KEY` invalidates signed reports | `src/services/encryption/at-rest.ts`, `docs/OPERATIONS.md` §4 |
| **C5** | 🟡 | S3 evidence code absent but prod R2 secrets set — configure a feature that doesn't run | `SHIPPING_STATUS.md` stubs |
| **C6** | 🟡 | `ALLOWED_ORIGINS` placeholder; `PII_REDACTION_ENABLED`/`LLM_CACHE_ENABLED` not pinned in `fly.toml`; provider catalog model IDs (`gpt-4o`, `gemini-1.5-flash`) need refresh against 2026 deprecations | `infra/fly-secrets.sh` §7, `src/config/llm-providers.ts` |

### 2.2 Cryptographic hardening backlog (G-items)

Shipped: **G1** (PII redaction), **G3** (graph tenant isolation), **G11** (prompt injection).
Open: **G2** key hierarchy · **G4** proof of deletion · **G5** audit-chain verification on read ·
**G6** threshold decryption · **G7** CSP `unsafe-inline` removal · **G8** PII-leak detection in
LLM outputs · **G9** forward secrecy · **G10** differential-privacy budget · **G12** webhook
key isolation. Specs, file targets, and test vectors are already drafted in
`docs/PLAN_SECURITY_HARDENING.md` — this plan sequences them (§3, Phase 1).

### 2.3 ML/data gaps (Vector/Graph Architect)

| Gap | Why it matters |
|---|---|
| **KYTClassifier deferred** (Sprint 6) | Blocked on >1,000 graph entities + transaction data source. Unblocks MiCA behavioral KYT + full-spectrum compliance narrative |
| **No golden datasets** | Harness primitives exist but `GoldenDataset` has no shipped dataset: entity-resolution F1 and cost-router tier-accuracy cannot be benchmarked. "F1 > 0.90" is currently unmeasurable |
| **No drift monitoring / threshold calibration** (P8) | Static guardrail thresholds degrade under temporal nonstationarity (Algorithmic Compliance, arXiv:2603.04328) |
| **Provider catalog staleness** | Costs and context windows are metadata; deprecation of listed model IDs silently breaks routing |

### 2.4 Feature stubs — finish or cut

| Stub | Disposition | Evidence |
|---|---|---|
| UBO extraction (`ubos: []` always in real mode) | **Finish** — draft-ready prompt | `docs/PLAN_UBO_EXTRACTION.md` |
| Webhook DLQ + replay + missing `case.created` | **Finish** — draft-ready prompt | `docs/PLAN_WEBHOOK_DLQ_REPLAY.md` |
| S3 evidence offload | **Finish or cut** — decide with C5 | `SHIPPING_STATUS.md` |
| Resend email | **Finish** (password-reset links currently logged) | `src/services/notifications/email.ts` |
| SSE streaming (single snapshot today) | **Cut to snapshot-or-poll** unless a customer asks | `src/api/routes/cases.ts` |
| `human-review.ts` node | **Wire or delete** — approval is an API route today | `src/graph/nodes/human-review.ts` |
| ~8 unused npm deps + missing `LICENSE` file | **Clean** | `package.json`, `SHIPPING_STATUS.md` |

### 2.5 Ops & BD gaps

Backups/PITR + restore drill (DORA evidence) · incident response runbook · sub-processor
DPA pack (OpenAI, Google, ComplyAdvantage, Stripe, Fly, Upstash/R2) · load benchmark
(dossier p95) · QTSP sandbox access (BD, unblocks Phase 6) · synthetic transaction data
partner for KYT (BD, unblocks Phase 3 real-data validation).

### 2.6 Repo hygiene (verified 2026-08-12)

macOS AppleDouble `._*` files pollute `src/**` and `tests/**` (e.g. `src/._index.ts`);
`.gitignore` covers `.DS_Store` but **not** `._*`. Harmless functionally, embarrassing in
due-diligence.

---

## §3 — Phased Execution Plan

Dependency order, owners, exact gates. Each phase is self-contained: it can be
handed to an IMPLEMENTER session with the listed docs as Load block.

### Phase 0 — Compliance & Config Foundation (est. 2 days) — *blocks everything*

**Objective:** production boots securely or not at all; every secret exists; observability on.

**Owner:** Principal AI Architect. **Review:** ZK/Privacy Guardian.

Build order:
1. `infra/fly-secrets.sh` — add `PII_REDACTION_KEY="$(openssl rand -hex 32)"` and
   `PII_REDACTION_ENABLED="true"` (§3, LLM block).
2. `src/config/env.ts` — production fail-closed: when `NODE_ENV === "production"`,
   require `ENCRYPTION_KEY`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `API_KEY_LOOKUP_SECRET`,
   `PII_REDACTION_KEY`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` (envalid `makeValidator` or
   post-parse assertion; crash at boot with a clear message, never a dev default).
3. `fly.toml` `[env]` — pin `OTEL_ENABLED="true"`, `PII_REDACTION_ENABLED="true"`,
   `LLM_CACHE_ENABLED="true"`; add OTEL endpoint + `REPORT_SIGNING_KEY` documented as
   rotate-with-re-sign-only.
4. Hygiene: add `._*` to `.gitignore`, delete tracked `._*` files; remove ~8 unused
   deps from `package.json`; add the `LICENSE` file (MIT, per `package.json`).
5. Verify `infra/cloudflare-waf.tf` deploy state; align `ALLOWED_ORIGINS` with the
   real production domain.

Testing:
- **NEW** `tests/unit/config/env.test.ts` — `vi.stubEnv` + dynamic import:
  prod without secrets → throws listing every missing var; prod with secrets → boots;
  dev without secrets → boots with defaults.
- **NEW** `tests/integration/config/boot-health.test.ts` — app with `NODE_ENV=production`
  and full secrets serves `/health` 200.
- `npm run test:no-llm`, `npm run typecheck`, `docker compose run --rm test` all green.

Gates: no prod boot without all C1/C2 secrets (test proves it) · zero-key demo intact
(`LLM_TIER_PRIMARY=t0` e2e passes) · coverage thresholds hold.

Rollback: `git revert` the Phase-0 commit; `fly secrets unset` any added secret.

### Phase 1 — Cryptographic Hardening Completion (est. 2–3 weeks) — ▶️ NEXT

> **Execution plan:** `docs/PLAN_CRYPTO_HARDENING_EXECUTION.md` (waves, exact file
> targets, tests, gates, rollback). Self-contained — no external API keys required;
> proceed while the deploy key is pending (ADR-024).

**Objective:** finish the 9 open G-items, highest-exploit-risk first.

**Owner:** ZK/Privacy Guardian. **Review:** Principal AI Architect.

Wave 1 (high risk, small surface): **G2** key hierarchy (KEK+DEK envelope), **G12**
webhook key isolation (HKDF domain separation), **G5** audit-chain verification
endpoint + verification on report read, **G7** nonce-based CSP, **G8** PII-leak
scanner on LLM outputs integrated into `guardrailNode`.
Wave 2 (needs design): **G4** proof of deletion (deletion certificates + DEK
destruction — requires G2), **G6** threshold decryption (Shamir 3-of-2 — policy
sign-off on key custody), **G9** forward secrecy (DEK rotation worker), **G10**
differential-privacy budget on graph queries (Laplace + budget tracker).

Testing (per spec already drafted in `PLAN_SECURITY_HARDENING.md` §1–§12, plus):
- Unit test vectors for every G-item (deterministic, no mocks beyond existing LLM mock).
- **NEW** `tests/integration/api/security-headers.test.ts` — CSP nonce present, no
  `unsafe-inline` (G7).
- **NEW** `tests/e2e/gdpr-erasure-proof.test.ts` — erase a case, assert deletion
  certificate row + DEK destruction marker (G4).
- **NEW** `tests/integration/api/audit-chain-verify.test.ts` — tamper one audit row
  in the test DB, assert verification fails loudly (G5).
- Failure-injection: kill Redis mid-case → webhook/queue recovery path exercised.

Gates: all new tests green · existing e2e lifecycle green · coverage ≥ current baseline
· G-items marked shipped in `SHIPPING_STATUS.md` with evidence links.

Rollback: each G-item ships independently; revert the G-item commit. G2 is reversible
only before tenant data re-encryption — run re-encryption as the last G2 step with a
backup taken immediately before.

### Phase 2 — Evaluation Infrastructure: Golden Datasets & Harness v2 (est. 1 week)

**Objective:** make every ML success metric measurable. No model change merges without
a benchmark (persona rule).

**Owner:** Vector/Graph Architect. **Review:** Principal AI Architect.

Build:
1. `tests/evaluation/datasets/entity-resolution-golden.json` — 50 synthetic-but-realistic
   entities (ADR-013: synthetic fixture, **flagged synthetic**, never seeded into prod):
   duplicates, near-duplicates ("Acme GmbH" vs "ACME GmbH Berlin"), cross-case merges.
2. `tests/evaluation/datasets/cost-router-golden.json` — 20 cases with expected tier
   (sanctions → t4, clean+complete → t0, standard → t2) + expected risk scores.
3. Harness v2 in `tests/evaluation/harness.ts` — add `evaluateEntityResolution(dataset)`
   and `evaluateRouter(dataset)` returning `EvaluationResult[]`; keep existing
   primitives; add `passed` gating and a JSON report writer.
4. `package.json` scripts: `test:eval` (harness + golden datasets, offline, mock LLM),
   `bench:router`, `bench:graph`.
5. CI: run `test:eval` in the compose `test` service; fail on any `passed: false`.

Testing:
- **NEW** `tests/evaluation/harness.v2.test.ts` — dataset integrity (unique caseIds,
  valid jurisdictions, tier values), evaluateResult semantics, report-writer determinism.
- Benchmark baselines recorded in `tests/evaluation/BASELINES.md` on first run.

Gates: entity-resolution F1 > 0.90 on the 50-entity golden set (tune deterministic
resolver until true — **no LLM in the resolver**); router tier agreement ≥ 0.85 with
expected tiers; tier ratio ≥ 0.60; cache-hit ≥ 0.15 on the 20-case replay.

Rollback: harness is additive; delete the new dataset files to revert.

### Phase 3 — KYTClassifier (Blue Ocean Sprint 6) (est. 2–3 weeks)

**Objective:** ship the deferred tree-ensemble typology classifier offline/CPU at
$0.00 marginal LLM cost, feeding the guardrail risk vector.

**Owner:** Vector/Graph Architect. **Review:** ZK/Privacy Guardian (data provenance).

Build (extends the deferred sketch in `PLAN_BLUE_OCEAN_IMPLEMENTATION.md` §7):
1. **Data first.** Synthetic wallet-transaction fixture generator
   (`tests/fixtures/transactions-synthetic.ts`): parameterized typologies —
   cybercrime dispersion (high-velocity, many counterparties), sanctions evasion
   (constrained, static), mixing (obfuscated flows), clean (retail patterns).
   Deterministic seed; all fixtures flagged synthetic (ADR-013).
2. Feature extraction (`src/services/kyt/features.ts`): value, frequency, velocity,
   counterparty diversity, time-of-day entropy, round-number ratios. Pure functions,
   typed in/out.
3. Model: LightGBM via a Node binding **or** ONNX Runtime for a trained
   LightGBM/XGBoost export (decide in §Phase-3 ADR-021; prefer ONNX — no native
   build issues, CPU-only). Training script (Python, repo-scoped under
   `ml/kyt/train.py` — explicitly NOT production runtime; the Node runtime loads
   the ONNX artifact).
4. Risk vector integration: `src/graph/nodes/guardrail.ts` consumes
   `kyt.typology` + `kyt.score` as *additional* evidence, never replacing the
   deterministic decision table (ADR-013 conservatism).
5. SHAP-style per-prediction feature-importance export into the dossier evidence
   (interpretability is a hard requirement).

Testing:
- **NEW** `tests/unit/services/kyt/features.test.ts` — feature values against
  hand-computed fixtures.
- **NEW** `tests/unit/services/kyt/model.test.ts` — ONNX artifact loads, inference
  matches recorded goldens byte-for-byte (deterministic).
- **NEW** `tests/evaluation/kyt-benchmark.ts` — 5-fold CV on the synthetic set.
- **NEW** `tests/integration/graph/kyt-guardrail.test.ts` — synthetic mixing wallet
  shifts risk tier; zero-key path unchanged.
- Regression: full `kyc-lifecycle` e2e stays green (KYT only activates when
  transaction data is present).

Gates: typology Macro-F1 > 0.85 · false-positive rate < 5% on the synthetic golden
set · inference p95 < 50ms CPU · zero LLM cost for KYT · e2e green with
`LLM_TIER_PRIMARY=t0`.

Rollback: remove the guardrail wiring commit — the decision table path is unchanged.

### Phase 4 — Feature Completion: Finish the Draft-Ready Prompts & Triage Stubs (est. 2–3 weeks)

**Objective:** turn two draft-ready prompts into shipped features and make a
finish-or-cut decision on every stub.

**Owner:** IMPLEMENTER sessions. **Review:** Principal AI Architect.

Build:
1. **UBO extraction** — execute `docs/PLAN_UBO_EXTRACTION.md` verbatim (officers API,
   first-page cap, verified-semantics, zero-key path returns `ubos: []`).
2. **Webhook DLQ + replay** — execute `docs/PLAN_WEBHOOK_DLQ_REPLAY.md` (terminal
   `failed` state, delivery history, per-delivery/bulk replay, `case.created` fix).
3. **S3 evidence offload** — decide with C5: wire `evidence` blob storage with
   content-addressed keys (SHA-256 path) or remove prod secrets and document Postgres
   as sole evidence store. Recommended: wire it (DORA data-recovery + GDPR erasure
   clean-up both get easier), behind `S3_ENABLED` flag default-on in prod.
4. **Resend email** — wire password-reset + welcome emails; keep mailpit in dev.
5. **SSE** — cut to snapshot-or-poll; remove the half-live stream unless customer demand.
6. **`human-review.ts`** — wire into approve flow or delete the node; no dead code.

Testing:
- UBO: extend `tests/unit/services/opencorporates-ubo.test.ts` with the real-API
  response fixtures from the prompt's §Verification; guardrail Medium+unverified
  stays HITL.
- Webhooks: **NEW** `tests/integration/api/webhook-dlq.test.ts` (exhaust retries →
  `failed`; replay → delivered; history queryable) + `case.created` e2e assertion.
- S3: **NEW** `tests/integration/services/evidence-s3.test.ts` against MinIO in compose.
- Email: unit test with mocked Resend client (existing notification service pattern).
- All: `docker compose run --rm test` green; coverage gates hold.

Gates: UBO path returns real verified officers with key; webhook deliveries recoverable;
zero-key demo byte-identical.

Rollback: per-prompt rollback lines (both drafts include them).

### Phase 5 — Operations & Continuous-Evaluation Readiness (est. 1–2 weeks + ongoing)

**Objective:** DORA-grade operations evidence + the drift monitoring that keeps
models honest after launch.

**Owner:** Principal AI Architect (ops) + Vector/Graph Architect (drift). **Review:** BD
(converts results into the sales deck).

Build:
1. Backups: Fly Postgres PITR + volume snapshots; **restore drill runbook** and one
   recorded drill (DORA evidence).
2. Incident runbook: roles, 72h GDPR Art. 33/34 notification path, comms templates.
3. Sub-processor DPA pack (BD drafts; legal reviews): OpenAI, Google, ComplyAdvantage,
   Stripe, Fly.io, Upstash/R2 — with EU-transfer mechanisms.
4. Load benchmark: `scripts/bench/dossier-latency.ts` — measure p95 of the full
   pipeline (t0) on the 20-case golden dataset; record in `tests/evaluation/BASELINES.md`.
5. Drift monitoring + threshold calibration (Blue Ocean P8): track guardrail
   decision distribution + LLM tier distribution + entity-resolution F1 weekly;
   alert on threshold drift; rolling recalibration runbook.
6. Provider catalog refresh cadence (quarterly) with a pinned-versions ADR.

Testing:
- Restore drill: scripted (`scripts/dr/restore-drill.sh`) with success criteria.
- **NEW** `tests/evaluation/drift-check.test.ts` — synthetic distribution shift
  triggers the drift alert.
- Benchmark rerun in CI (weekly cron) — fails on >15% p95 regression.

Gates: one recorded successful restore · p95 dossier latency baselined (target:
<30s wall-clock for the t0 path at 2 vCPU) · drift alerts firing on injected shift.

Rollback: ops artifacts are additive; disable the cron if noisy.

### Phase 6 — Blue Ocean Integrations (ZKP, eIDAS, Agentic Fraud) — contract-first, gated

**Objective:** land Phases 2–4 of `BLUE_OCEAN_ARCHITECTURE.md` *after* Phases 0–5,
with Zod contracts written before any implementation.

**Owner:** Principal AI Architect + ZK/Privacy Guardian. **BD dependency:** QTSP
sandbox access + 1 design partner (see `MARKET_INTELLIGENCE.md` pipeline).

Build (contracts first, in this order):
1. `src/graph/schemas.ts` — `ZkpVerificationResultSchema`, `EidasCertificateSchema`
   (typed before nodes exist).
2. ZKP verifier node (ZK-Compliance/FC-GUARD design; <500ms server-side verification).
3. eIDAS verifier node (LotL → member-state → QTSP chain; test against QTSP sandbox
   certificates — BD must deliver).
4. Agentic fraud agents only after vision-model policy cleared against the AI Act
   (no remote biometric identification — Art. 5 restrictions reviewed with counsel).

Testing: evaluation harness extended per subsystem; golden certificate fixtures;
negative tests (expired/revoked certs, wrong trust anchor) before any happy-path demo.

Gates: ZKP verify <500ms p95 · eIDAS chain verify <2s · no PII stored for
ZKP-onboarded users · external audit passed before go-live.

Rollback: feature flags (`ZKP_ENABLED`, `EIDAS_ENABLED`, default off).

---

## §4 — Testing Strategy (How "Thorough" Is Enforced)

### 4.1 The pyramid (commands)

| Layer | Command | What it proves |
|---|---|---|
| Unit | `npm run test:unit` | Pure logic: env fail-closed, features, signer, resolver, redactor, classifier |
| Integration | `npm run test:integration` | Real Postgres+Redis: API contracts, DLQ, S3, graph isolation |
| E2E | `tests/e2e/` via `docker compose run --rm test` | Full lifecycle on the real stack, incl. GDPR erase |
| Evaluation | `npm run test:eval` | Model quality: F1, tier agreement, cache-hit, cost delta, drift |
| Security | per-G-item unit vectors + header/audit-chain integration tests | Exploit scenarios are tests, not prose |
| Performance | `scripts/bench/*` + weekly CI cron | p95 latency + regression alarms |

### 4.2 Test-matrix per phase (new files)

| Phase | New tests (paths) |
|---|---|
| 0 | `tests/unit/config/env.test.ts`, `tests/integration/config/boot-health.test.ts` |
| 1 | `tests/integration/api/security-headers.test.ts`, `tests/e2e/gdpr-erasure-proof.test.ts`, `tests/integration/api/audit-chain-verify.test.ts` |
| 2 | `tests/evaluation/harness.v2.test.ts`, `tests/evaluation/datasets/*.json`, `tests/evaluation/BASELINES.md` |
| 3 | `tests/unit/services/kyt/{features,model}.test.ts`, `tests/evaluation/kyt-benchmark.ts`, `tests/integration/graph/kyt-guardrail.test.ts`, `tests/fixtures/transactions-synthetic.ts` |
| 4 | `tests/integration/api/webhook-dlq.test.ts`, `tests/integration/services/evidence-s3.test.ts` + extended UBO/email tests |
| 5 | `tests/evaluation/drift-check.test.ts`, `scripts/bench/dossier-latency.ts`, `scripts/dr/restore-drill.sh` |

### 4.3 Hard gates (enforced, non-negotiable)

| Gate | Baseline / Target | Enforced by |
|---|---|---|
| Coverage | ≥ 60/40/55/60 (current 66.6/54.8/68.6/67.7) | `vitest.config.ts` thresholds |
| Zero-key demo | `LLM_TIER_PRIMARY=t0` full e2e green | `npm run test:no-llm` + compose test service |
| LLM never sees PII | every prompt redacted (G1) + `PII_REDACTION_KEY` distinct (C1) | unit vectors + prod fail-closed |
| Router economics | ≥60% calls on t0–t2 · cache-hit ≥15% · cost-delta recorded | `test:eval` |
| Entity resolution | F1 > 0.90 on 50-entity golden set | `test:eval` |
| KYT | Macro-F1 > 0.85 · FPR < 5% · p95 < 50ms | `test:eval` + bench |
| Audit integrity | tampered chain detected | G5 integration test |
| Erasure | deletion certificate emitted (G4) | e2e |

### 4.4 Failure injection (non-negotiable for async paths)

Kill Redis/Postgres mid-case · webhook retries exhausted · LLM provider timeout →
t0 fallback · malformed Zod payloads → RFC7807 error shape (already contracted in
`tests/integration/api/contract.test.ts`; extend for new routes).

### 4.5 Data ethics for fixtures

All synthetic fixtures carry a `synthetic: true` marker and are never seeded into
production data (ADR-013: never invent entity data). KYT synthetic data is labeled
in the dataset header; any real transaction data arrives only via BD-negotiated
anonymized pilots under NDA.

---

## §5 — Milestones & Go/No-Go Gates

| Milestone | Criteria | Go | No-Go |
|---|---|---|---|
| End Phase 0 | Prod boot fails closed; all secrets injected; OTEL on | Proceed | Fix config; no feature work |
| End Phase 1 | 9 G-items shipped with passing exploit tests | Proceed | Ship nothing privacy-branded |
| End Phase 2 | Both golden datasets pass gates in CI | Unlock Phase 3 + all model work | No model changes allowed |
| End Phase 3 | KYT gates green on synthetic set | Pilot with BD-partner data | Iterate features/model; never ship |
| End Phase 4 | UBO + webhook DLQ live; stub triage decided | Proceed | Keep stubs documented, not silent |
| End Phase 5 | Restore drill recorded; p95 baselined; drift alert live | Enterprise readiness declared | Fix ops before Enterprise pitch |
| Phase 6 entry | QTSP sandbox + design partner signed | Start ZKP/eIDAS contracts | Wait; do not pre-build on guesses |

---

## §6 — Risk Register (top 10, condensed)

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | LLM provider compromise exposes pseudonymized prompts | Low | High | G1 shipped; G8 output scan; Phase 1 |
| 2 | Single key compromise = all tenants | Low | Critical | G2 key hierarchy (Phase 1) |
| 3 | Deleted cases recoverable → GDPR Art. 17 failure | Med | High | G4 proof of deletion (Phase 1) |
| 4 | KYT model drifts after launch | Med | Med | Phase 5 drift monitoring + P8 calibration |
| 5 | ONNX/LightGBM runtime choice adds native dep | Med | Low | ADR-021 decision before coding; ONNX preferred |
| 6 | `._*` AppleDouble files in due-diligence | High | Low | Phase 0 hygiene |
| 7 | QTSP/EUDI integration slips past end-2026 wallet deadline | Med | High | BD starts sandbox talks now; Phase 6 flag-off fallback |
| 8 | Rotating `REPORT_SIGNING_KEY` invalidates old reports | Med | Med | Documented re-sign window; C4 |
| 9 | S3 feature drift (secrets set, code absent) misleads auditors | Med | Med | C5 decision in Phase 4 |
| 10 | Coverage gates pass while eval gates are skipped in CI | Med | Med | `test:eval` wired into compose `test` service |

---

## §7 — Definition of Done (applies to every phase)

1. Typecheck + build green; `docker compose run --rm test` green (coverage gates hold).
2. Zero-key path verified (`LLM_TIER_PRIMARY=t0`).
3. Every new function called in the pipeline (no orphaned code) and every new file
   referenced by an import chain.
4. Every LLM output Zod-validated (ADR-007).
5. Benchmark recorded in `tests/evaluation/BASELINES.md` with baseline vs. current.
6. Rollback documented (one sentence).
7. `SHIPPING_STATUS.md` updated with evidence links.

---

## Appendix A — Source Register

Repo inventory verified 2026-08-12: `src/**` (138 files), `tests/**` (61 files),
`docs/DECISIONS.md` (ADR-001…020), `docs/PLAN_SECURITY_HARDENING.md` (G1–G12,
3 shipped), `docs/PLAN_BLUE_OCEAN_IMPLEMENTATION.md` (Sprints 1–5 shipped, §7
KYT sketch, §13 execution log), `docs/PLAN_UBO_EXTRACTION.md` +
`docs/PLAN_WEBHOOK_DLQ_REPLAY.md` (both draft-ready), `docs/SHIPPING_STATUS.md`
(capability matrix), `docs/OPERATIONS.md` (runbook), `vitest.config.ts` (gates),
`src/config/env.ts` + `infra/fly-secrets.sh` + `fly.toml` (config gaps C1–C6).
External (2026-08-12): ESMA MiCA register current; EUDI Wallets due end-2026
(Reg. (EU) 2024/1183); AMLR (EU) 2024/1624 applies 2027-07-10; DORA
(EU) 2022/2554 applied since 2025-01-17.
