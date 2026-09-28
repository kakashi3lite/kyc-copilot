# CONTEXT_INDEX — KYC Copilot Context Router

> TL;DR: Read this file first. Pick your task type, adopt the role, run the instruction set, load only the listed files.

## Session start (mandatory)

1. Read this file.
2. Adopt role from matrix below → `docs/roles/<ROLE>.md`
3. Run instruction set → `docs/instructions/IS-xxx-*.md`
4. Load only files in the **Load** column — never the full repo.
5. On exit: run **IS-006** → write `.session-state.yaml` from `docs/templates/SESSION_STATE.yaml`

## Task → Load Matrix

| Task type | Role | IS | Load (in order) | ~Tokens |
|---|---|---|---|---|
| New cross-cutting feature | ARCHITECT | IS-001 | CONTEXT_INDEX → ARCHITECTURE_CONTEXT §1-3,9 → DECISIONS → roles/ARCHITECT | 2.5k |
| Graph / pipeline change | IMPLEMENTER | IS-002 | kyc-graph.mdc → ARCHITECTURE_CONTEXT §5 → `src/graph/graph.ts` → affected node | 1.5k |
| API route change | IMPLEMENTER | IS-003 | kyc-api.mdc → ARCHITECTURE_CONTEXT §7 → `src/api/routes/*.ts` | 1.2k |
| DB / schema change | IMPLEMENTER | IS-004 | ARCHITECTURE_CONTEXT §6 → `src/db/schema.ts` → migrations | 1k |
| Frontend / UX change | IMPLEMENTER | IS-005 | kyc-frontend.mdc → ARCHITECTURE_CONTEXT §11 → `public/*.html` | 800 |
| Compliance / audit review | COMPLIANCE_OFFICER | IS-001 | kyc-compliance.mdc → INV-001..007 → DECISIONS ADR-002,005,007 | 1.5k |
| Code review / PR | REVIEWER | IS-001 | DECISIONS → invariants → changed files only | 1k |
| Update context docs | CONTEXT_WRITER | IS-006 | All `docs/` → diff against codebase | 3k |
| Session end (any role) | current | IS-006 | Write `.session-state.yaml` | 300 |
| MVP shipping implementation | IMPLEMENTER | IS-001 | `docs/PLAN_MVP_SHIP.md` → ARCHITECTURE_CONTEXT §5,7,8,11 → affected files | 3k |
| Post-ship review / roadmap | ARCHITECT | IS-001 | `docs/SESSION_REPORT_2026-08-03.md` → `docs/SHIPPING_STATUS.md` → DECISIONS ADR-013 | 3k |
| Business MVP implementation | IMPLEMENTER | IS-001 | `docs/PLAN_BUSINESS_MVP_IMPLEMENTATION.md` → ARCHITECTURE_CONTEXT §3,5,7,8,11 → affected files | 4k |
| Billing / Stripe change | IMPLEMENTER | IS-003 | ARCHITECTURE_CONTEXT §7 → `src/services/billing/*` → `src/api/routes/{billing,stripe-webhook,users}.ts` → `plan-gate.ts` | 1.5k |
| Report / signing change | IMPLEMENTER | IS-003 | ARCHITECTURE_CONTEXT §7 → `src/services/reports/{signer,generator,pdf-renderer}.ts` | 1k |
| LLM routing / cost / cache | IMPLEMENTER | IS-002 | `PLAN_BLUE_OCEAN_IMPLEMENTATION.md` §1-4,13 → `src/services/llm/{router,budget,difficulty-classifier,cache,cost-tracker,audit}.ts` → adapters | 2.5k |
| RAG-Graph / entity resolution | IMPLEMENTER | IS-004 | `PLAN_BLUE_OCEAN_IMPLEMENTATION.md` §5-6,13 → `src/db/schema.ts` → `src/services/kyc-data/{entity-resolver,graph-query}.ts` → `src/graph/nodes/draft-dossier.ts` | 2k |
| Evaluation / model benchmark | IMPLEMENTER | IS-002 | `tests/evaluation/BASELINES.md` → `tests/evaluation/harness.ts` → `tests/evaluation/datasets/*.json` | 1k |
| Canada demo / prospect package | IMPLEMENTER | IS-001 | `docs/DEMO_PACKAGE_CANADA_2026-09-28.md` → `docs/CANADIAN_MARKET_IMPACT_BRIEF.md` | 1.5k |
| Security hardening / ZKP | IMPLEMENTER | IS-002 | `docs/PLAN_SECURITY_HARDENING.md` → `docs/PLAN_CRYPTO_HARDENING_EXECUTION.md` → `SECURITY.md` → `src/services/llm/pii-redactor.ts` → `src/services/encryption/at-rest.ts` | 2.5k |
| Production run / ops | — | — | `docs/OPERATIONS.md` → `SECURITY.md` → `infra/*` | 2k |
| Crypto hardening (Phase 1, next) | ZK/Privacy Guardian | IS-002 | `docs/PLAN_CRYPTO_HARDENING_EXECUTION.md` → `docs/PLAN_SECURITY_HARDENING.md` §2–§12 → `src/services/encryption/at-rest.ts` | 3k |
| Ops readiness (Phase 5, shipped) | — | — | `docs/DR_RUNBOOK.md` → `docs/INCIDENT_RUNBOOK.md` → `docs/DPA_PACK.md` → `docs/dr-drill-log.txt` | 1.5k |

## Anti-patterns

- Do NOT paste conversation history into new sessions.
- Do NOT load README if ARCHITECTURE_CONTEXT §2 covers the contract.
- Do NOT read all of `src/` — use file map in ARCHITECTURE_CONTEXT §9.
- Do NOT re-explain invariants in chat — cite `INV-00x`.
- Do NOT end a session without `.session-state.yaml`.

## Quick pointers

| Need | Go to |
|---|---|
| System map | `docs/ARCHITECTURE_CONTEXT.md` §3 |
| Graph pipeline | `docs/ARCHITECTURE_CONTEXT.md` §5 |
| API routes | `docs/ARCHITECTURE_CONTEXT.md` §7 |
| DB tables | `docs/ARCHITECTURE_CONTEXT.md` §6 |
| Why a choice was made | `docs/DECISIONS.md` |
| Active roadmap / phase status | `docs/PLAN_PRODUCTION_READINESS.md` (§Phase Status — Phases 0–5 shipped, Phase 1 next) |
| Next phase execution (crypto hardening) 🆕 | `docs/PLAN_CRYPTO_HARDENING_EXECUTION.md` (approved for implementation) |
| MVP shipping plan (shipped) | `docs/PLAN_MVP_SHIP.md` (Phases done 2026-08-03) |
| AI subsystems plan + execution log | `docs/PLAN_BLUE_OCEAN_IMPLEMENTATION.md` (Sprints 1–5 shipped, §13) |
| Business MVP (shipped) | `docs/PLAN_BUSINESS_MVP_IMPLEMENTATION.md` — Phases A–G done 2026-08-04 |
| Operations runbook | `docs/OPERATIONS.md` |
| Security posture | `SECURITY.md` |
| Security hardening plan (cryptographic defense in depth) 🆕 | `docs/PLAN_SECURITY_HARDENING.md` |
| Next feature: UBO extraction | `docs/PLAN_UBO_EXTRACTION.md` (draft-ready) |
| Next feature: webhook DLQ + replay | `docs/PLAN_WEBHOOK_DLQ_REPLAY.md` (draft-ready) |
| Shipping status / stubs | `docs/SHIPPING_STATUS.md` |
| Evaluation gates / golden datasets | `tests/evaluation/BAS
| Canada demo package (Loom script + checklist + FAQ) | `docs/DEMO_PACKAGE_CANADA_2026-09-28.md` |
| Canada market brief (prospect one-pager) | `docs/CANADIAN_MARKET_IMPACT_BRIEF.md` |ELINES.md` |
| Market & BD intelligence | `docs/MARKET_INTELLIGENCE.md` |
| Session report (this ship) | `docs/SESSION_REPORT_2026-08-03.md` |
| Product screenshots | `docs/screenshots/*.png` |
| Last session state | `.session-state.yaml` (project root, gitignored) |
| Cursor rules | `.cursor/rules/kyc-*.mdc` |

## Repo

- Path: `/Users/kakashi3lite/kyc-copilot`
- Remote: `github.com/kakashi3lite/kyc-copilot`
- Version: 1.1.0 (Business MVP shipped 2026-08-04)
- Verify: `npm run typecheck && npm run test`
