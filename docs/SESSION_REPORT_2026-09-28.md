---
repo: kyc-copilot
path: /Users/kakashi3lite/kyc-copilot
doc: SESSION_REPORT_2026-09-28
title: Session Report — Demo Readiness & Repo Sync Audit
status: complete
updated: 2026-09-28
scope: demo-path blockers fixed, GitHub CI gap fixed, migration journal fix, docs↔code sync, full-stack verification
related:
  - README.md
  - SHIPPING_STATUS.md
  - CONTEXT_INDEX.md
  - ARCHITECTURE_CONTEXT.md
  - tests/evaluation/BASELINES.md
---

# Session Report — Demo Readiness & Repo Sync Audit

> **One-line summary:** Fixed four demo-blocking defects (wrong compose service
> in `npm run demo`, seed CLI hang, migration-journal gap, GitHub CI missing the
> migration step), synced documentation to code, and verified the zero-key demo
> end-to-end — 223/223 tests host-side, compose gate EXIT 0, live API smoke green.

---

## 1. Defects Fixed

| # | Defect | Impact | Fix | Evidence |
|---|---|---|---|---|
| 1 | `npm run demo` referenced a non-existent compose service `db` | `npm run demo` failed on step 1 for every fresh clone | `package.json` → `docker compose up -d postgres redis …` | `docker compose config --services`; live run |
| 2 | `npm run db:seed` hung after success (open ioredis handle kept the event loop alive) | The `&&` chain never reached `npm run dev`; demo stalled silently | `src/db/seed.ts` CLI block closes Redis + pool, exits 0/1 | Seed completes in **0.98 s** (was: hung indefinitely) |
| 3 | `_journal.json` was missing the `0005_great_the_watchers` entry | Fresh clones skipped the webhook-DLQ migration (`failed_at`, `last_http_status`); SQL + snapshot were committed but the journal was not | Committed the journal entry; re-ran migrate | Dev DB advanced **4 → 6** migrations; DLQ columns + 3/3 graph tables verified |
| 4 | GitHub `ci.yml` ran the full suite (incl. real E2E) **without** `npm run db:migrate` | GitHub Actions red on every push; the e2e requires a migrated DB (per `tests/e2e/kyc-lifecycle.test.ts`) | Added migrate step + `LLM_TIER_PRIMARY=t0` / `LLM_SYNC_ALLOWED_TIERS=t0` (mirrors GitLab `full-gate` and compose `test`) | Workflow YAML validated; host suite (same steps) green |
| 5 | Docs drift | `ARCHITECTURE_CONTEXT` §1 showed v1.0.0 (package is 1.1.0); README said ADR-001→017 (max is ADR-024); `MARKET_INTELLIGENCE.md` contained agent-wrapper artifacts | Version fixed; ADR range fixed; wrapper artifacts ("Save this as…", outer fence, "enable file-writing tools" tail) removed | `grep` + render check |
| 6 | `.env.example` hostnames ambiguous | Host-run dev (`localhost`) vs compose (`postgres`/`redis`) confusion | Added a comment block documenting when to use which file; env defaults already point at localhost | — |
| 7 | 6 npm advisories (1 high: `nanoid`; moderate: `hono`, `qs`, `vitest`) | GitHub Dependabot flagged 11 alerts on the public repo | `npm audit fix --legacy-peer-deps` — lockfile-only, semver-compatible bumps | `npm audit`: **0 vulnerabilities**; typecheck + 223/223 re-run green |

## 2. README Refresh (previous session, committed here)

- **📈 Business Impact** — hook (60% less manual verification) + measured bullets
  (3.5 h → ~14 min, €380/case, ~92% lower dossier cost vs all-frontier).
- **🏗 Architecture at a Glance** — Mermaid diagram: Input → RAG-Graph agent
  (`KycGraph` pipeline, LangChain.js adapters) → PostgreSQL 16 (evidence ledger,
  RAG-Graph, audit) → verified output/audit, with HITL branch.
- **🛠 Tech Stack** — keyword table (TypeScript, LangChain.js, RAG, PostgreSQL,
  Redis, Docker, Structured Prompt Engineering via Zod).
- Accuracy corrections: pipeline is the imperative `KycGraph` (ADR-001, NOT a
  compiled LangGraph StateGraph); embeddings are JSONB staged for pgvector; the
  product intake is identifiers (PDFs are signed **outputs**).

## 3. Verification Evidence (2026-09-28)

| Gate | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | ✅ pass |
| Unit | `npm run test:unit` | ✅ 159/159 |
| Evaluation gates | `npm run test:eval` / `bench:eval` | ✅ 24/24 — entity F1 **1.000**, low-cost ratio **0.800**, KYT macro-F1 **1.000**, cost $0.0024 vs $0.0291/dossier |
| Full suite (host) | `LLM_TIER_PRIMARY=t0 npm run test` | ✅ **223/223** (38 files), coverage **71.59% lines** (gate 60%) |
| Compose gate | `docker compose run --rm test` | ✅ **EXIT 0** — migrate + full suite (37 files) against compose Postgres + Redis |
| Live demo | `npm run db:seed` + `npm run dev` + curl | ✅ `/health` ok (db+redis true) · landing 200 · Acme → `completed` · Volkov → `pending_hitl` |
| Router (live logs) | dev server | Acme → **t2** "complete data, low risk"; Volkov → **t4** "sanctions or PEP flag"; deterministic fallback without keys |

## 4. Environment Note (local machine only — no repo change needed)

- Homebrew PostgreSQL 16.14 owns `localhost:5432`; Docker's Postgres is shadowed
  for **host-side** connections (the compose network still resolves
  `postgres` → Docker PG for the app/test containers). The host demo therefore
  uses the Homebrew `kyc` DB (migrated 6/6, seeded, idempotent seed verified).
- `kyc_fresh` scratch DB left in the compose Postgres from migration testing —
  harmless; drop with `docker compose exec postgres dropdb -U kyc kyc_fresh` if desired.

## 5. Files Changed

| File | Change |
|---|---|
| `README.md` | Business Impact + Architecture + Tech Stack; ADR range → 024 |
| `package.json` | `demo` script: `db redis` → `postgres redis` |
| `src/db/seed.ts` | Close Redis/pool handles on exit (demo-blocker fix) |
| `src/db/migrations/meta/_journal.json` | Added `0005_great_the_watchers` entry |
| `.github/workflows/ci.yml` | Added DB migrate step + t0 tier env |
| `.env.example` | Compose-vs-host hostname note |
| `docs/ARCHITECTURE_CONTEXT.md` | §1 version 1.0.0 → 1.1.0; updated date |
| `docs/MARKET_INTELLIGENCE.md` | Removed wrapper artifacts; normalized front matter |
| `docs/CONTEXT_INDEX.md` | Added evaluation + market-intelligence load rows |

## 6. Risks / Deferred

- GitHub Actions is blocked by an account-level billing lock (jobs never start:
  "The job was not started because your account is locked due to a billing
  issue"). Not a repo defect — resolve billing at github.com/settings/billing;
  the workflow config is validated locally. The GitLab pipeline is the primary CI.
- `bench:drift` baseline is from 2026-08-13 — re-run before any model/classifier change.
- Phase 1 (cryptographic hardening, ADR-024) remains the next feature track.

## 7. Handoff

- **Pushed:** `main` → `origin` (GitHub) and `gitlab` — GitHub was 5 commits
  behind at session start; this push brings it current.
- **GitHub Actions:** account-level billing lock blocks all runs (not a repo
  defect). The `Deploy` workflow was switched to manual `workflow_dispatch`
  (ADR-024 alignment — deploy is key-gated); push coverage stays with `ci.yml`.
- **Demo package (same day):** Canadian prospect package added —
  `docs/DEMO_PACKAGE_CANADA_2026-09-28.md` (repo scan + Loom script + checklist + FAQ)
  and `docs/CANADIAN_MARKET_IMPACT_BRIEF.md` (standalone one-pager).
- **Next:** Phase 1 crypto hardening per `docs/PLAN_CRYPTO_HARDENING_EXECUTION.md`.
