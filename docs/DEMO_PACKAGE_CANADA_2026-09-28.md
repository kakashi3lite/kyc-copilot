---
repo: kyc-copilot
path: /Users/kakashi3lite/kyc-copilot
doc: DEMO_PACKAGE_CANADA_2026-09-28
title: Canadian Demo Package — repo scan, Loom script, checklist, FAQ (HEAD ccbbba4)
status: ready-for-demo
updated: 2026-09-28
scope: Canadian prospect demo package; every figure traces to SESSION_REPORT_2026-09-28 §3 / tests/evaluation/BASELINES.md — nothing re-derived
related:
  - CANADIAN_MARKET_IMPACT_BRIEF.md
  - SESSION_REPORT_2026-09-28.md
  - tests/evaluation/BASELINES.md
  - SECURITY.md
---

# Canadian Demo Package — 2026-09-28

> Provenance: all figures trace to `docs/SESSION_REPORT_2026-09-28.md` §3 and
> `tests/evaluation/BASELINES.md`. Verified on HEAD `ccbbba4`. No emojis by design.
> Package-wide FX assumption (stated once): 1 EUR ≈ 1.47 CAD; all CAD figures are
> illustrative conversions, not verified rates.

## Phase 1 — Repo Scan (audit trail)

| Capability | Current Implementation | Canadian Equivalent | Gap / Notes |
|---|---|---|---|
| Corporate EDD dossier generation | 6-stage `KycGraph` pipeline: intake → registry + screening → browser fallback → entity resolution / RAG-Graph → KYT check → dossier drafting → guardrail (`README.md`, "Architecture at a Glance") | Core workflow reusable for PCMLTFA client due diligence and risk assessment | 3.5 h → ~14 min baseline is the verified figure |
| Registry lookup | OpenCorporates v0.4 client (companies + officers endpoints; per-endpoint circuit breakers, 3-attempt retry, 15s timeouts; public endpoint — 401 without key observed in demo) composed with ComplyAdvantage (`src/services/kyc-data/opencorporates.ts`, `adapter.ts`) | Corporations Canada registry | No Corporations Canada adapter at this HEAD. Plug-in point: implement `KycDataAdapter.lookup()` (`src/services/kyc-data/adapter.ts`), register in `CompositeKycDataAdapter`, injected via `ApiLookupDependencies` (`src/graph/nodes/api-lookup.ts`) |
| Corporations Canada adapter requirements | Not present (roadmap) | Corporations Canada registry | Needs: the `KycDataAdapter` interface; an env-key auth pattern (mirror `COMPLY_ADVANTAGE_API_KEY`); resilience pattern (CircuitBreaker + `withRetry` + `AbortSignal` timeout + input sanitization); mapping into the Zod-validated `ApiCompanyData` schema (`legalName`, `registrationNumber`, `jurisdiction`, `status`, `ubos[{name, verified, ownershipPct}]`, `sanctions`, `pep`, `sourceUrl`, `completeness`) |
| Sanctions / PEP screening | ComplyAdvantage client; flags drive escalation (`src/services/kyc-data/comply-advantage.ts`, guardrail decision table) | FINTRAC sanctions and PEP screening expectations | Adapter present; Canadian list coverage not independently verified in this scan |
| Beneficial ownership (UBO) extraction | Officers-endpoint extraction with soft-degrade; ownership % coerced or `null` — never invented (`ADR-014`, `opencorporates.ts`) | FINTRAC beneficial ownership; Corporations Canada BO reporting | Real-key path requires an OpenCorporates key; zero-key demo returns no UBOs by design (`ADR-013`) |
| Evidence ledger | Hash-chained `evidence` table (`key`, `sourceUrlEncrypted`, `contentHash`, `previousHash`); INV-001 / INV-002 (`docs/ARCHITECTURE_CONTEXT.md` §6, §8) | Audit-grade documentation for regulator exams | Per-case chain; retention policy is operator configuration |
| Guardrail | Mechanically strips uncited claims; sets final status (`src/graph/nodes/guardrail.ts`) | Audit integrity for regulated reporting | Not configurable off (INV-002) |
| Report integrity | HMAC-SHA256 content signature + public verify endpoint (`src/services/reports/signer.ts`) | Tamper-evident documentation | CA-issued PKCS#7 signatures deferred to Enterprise |
| Human review (HITL) | `pending_hitl` on sanctions/PEP/high risk/partial data; INV-007: no auto-approve, 404/409 semantics, atomic status update | PCMLTFA enhanced measures with documented decisions | Approval requires a named analyst |
| Audit trail | Append-only hash-chained `audit_logs` (`actor`, `action`, `hash`, `oldValue`, `newValue`); INV-004 | Recordkeeping and examination trails | Persisted in PostgreSQL |
| PII protection | AES-256-GCM at rest; masked displays; deterministic pseudonym redaction before LLM prompts (`SECURITY.md` §1) | PIPEDA privacy safeguards (mapped from the repo's GDPR-era controls) | PIPEDA-specific legal review not performed — do not assert compliance on camera |
| KYT typology check | Deterministic CPU-only classifier, $0.00 marginal LLM cost; transparent no-op without wallet transaction data (`src/graph/nodes/kyt.ts`, ADR-021) | FINTRAC transaction monitoring concepts | No Canadian transaction data source connected — roadmap |
| Cost routing | 5-tier t0 → t4; live logs: Acme → t2, Volkov → t4 | Operational cost efficiency for Canadian reporting entities | Verified on HEAD `ccbbba4` |
| Cross-case entity graph | Tenant-scoped RAG-Graph tables + deterministic entity resolution | Relationship-based risk assessment | Cross-tenant federation is opt-in, never default |

| Item | Status | Evidence Path |
|---|---|---|
| Blocker 1 — `npm run demo` referenced compose service `db` | Fixed (`postgres`) | `package.json` (scripts.demo); `docs/SESSION_REPORT_2026-09-28.md` §1 |
| Blocker 2 — `npm run db:seed` hung after success | Fixed — exits in ~0.98 s (closes Redis/pool) | `src/db/seed.ts`; session report §1 |
| Blocker 3 — migration journal missing 0005 | Fixed — DB advanced 4 → 6 migrations; DLQ columns verified | `src/db/migrations/meta/_journal.json`; `src/db/migrations/0005_great_the_watchers.sql`; session report §1 |
| Blocker 4 — GitHub CI ran e2e without migrating | Fixed — migrate step + t0 env added | `.github/workflows/ci.yml`; session report §1 |
| Demo case — Acme Logistics BV / NL | Verified → `completed` (low-risk auto path) | Session report §3 (live curl); reproduced on HEAD `ccbbba4` |
| Demo case — Volkov Capital Partners / CY | Verified → `pending_hitl` (analyst approve path) | Session report §3; reproduced on HEAD `ccbbba4` |
| CI migrate fix | Complete — mirrors GitLab `full-gate` and compose `test` | `.github/workflows/ci.yml`; `tests/e2e/kyc-lifecycle.test.ts` (requires migrated DB) |
| npm audit result | 0 vulnerabilities (was 6, incl. 1 high) | `package-lock.json`; session report §1 item 7 |

PHASE 1 COMPLETE.

## Terminology Replacements (applied throughout)

| Repo Term | Canadian Replacement |
|---|---|
| AMLD6 | PCMLTFA |
| EU payments institution | Canadian reporting entity |
| OpenCorporates | Corporations Canada (roadmap) / zero-key synthetic (demo) |
| € | CAD (state FX assumption once, up front) |
| EU registry | Corporations Canada registry |
| GDPR | PIPEDA |

## Deliverable A — Loom Script (60–90 seconds)

| Timestamp | Visual (on-screen) | Narration (say this) |
|---|---|---|
| 0:00 | Landing page — hero headline | "A Canadian compliance analyst spends about three and a half hours on each corporate enhanced due diligence review. This platform produces the same review, evidence-backed, in about fourteen minutes." |
| 0:10 | New-case modal — three fields: company name, registration number, jurisdiction | "Intake is three fields. No document uploads; the system fetches its own evidence. The demo runs on the zero-key synthetic path today; Corporations Canada integration is on the roadmap." |
| 0:25 | Case detail / evidence ledger populating | "Registry lookup, sanctions and PEP screening, and beneficial-ownership extraction populate the evidence ledger. Every claim is hash-chained and timestamped. And that record matters: FINTRAC's beneficial-ownership rules include a thirty-day discrepancy reporting window." |
| 0:45 | Dossier view — cited claims, signature block | "Every claim in this dossier cites its evidence. Anything uncited is mechanically stripped by the guardrail — audit-grade by construction. Reports carry an HMAC-SHA256 signature and are publicly verifiable." |
| 1:05 | Approve / pending_hitl control | "Acme Logistics BV, Netherlands — completes automatically. Volkov Capital Partners, Cyprus — locks at pending hitl until a named analyst approves. There is no automated path around human review." |
| 1:20 | ROI card | "The ROI card shows roughly three hundred and eighty euros per case avoided — at current FX, roughly one euro to one point four seven Canadian dollars, about five hundred and sixty Canadian dollars; that conversion is illustrative. FINTRAC-ready documentation in minutes, not hours." |

## Deliverable B — Canadian Market Impact Brief

Standalone, prospect-facing one-pager: see [`CANADIAN_MARKET_IMPACT_BRIEF.md`](CANADIAN_MARKET_IMPACT_BRIEF.md).
It carries sections 1–6 (problem, pipeline, quantified impact, technical proof,
compliance alignment, reproducibility) for readers who have never seen the repo.

## Deliverable C — Demo-Day Checklist

### Environment

- [ ] Review `.env.example`: required variables include `DATABASE_URL`, `REDIS_URL`, `ENCRYPTION_KEY`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `API_KEY_LOOKUP_SECRET`, `REPORT_SIGNING_KEY` (empty = unsigned reports), `APP_BASE_URL`.
- [ ] Compose-vs-host hostnames understood: the file uses `postgres` / `redis` for `docker compose up`; host-run dev uses `localhost` defaults (comment block added 2026-09-28).
- [ ] Postgres quirk understood: Homebrew PostgreSQL 16.14 owns `localhost:5432` for host-run dev. The demo uses the Homebrew `kyc` database (migrated 6/6, seeded); Docker's Postgres serves the compose network only.

### Seed + start

- [ ] `npm run db:migrate` completes (6 migrations; dev DB advanced 4 → 6 this session).
- [ ] `npm run db:seed` exits in ~0.98 s (previously hung indefinitely — verify the fast exit).
- [ ] `npm run demo` starts with compose service `postgres` (verify `package.json`, not `db`).

### Pre-record verification

- [ ] curl both cases; confirm Acme Logistics BV → `completed` and Volkov Capital Partners → `pending_hitl`.
- [ ] Check router logs: Acme → t2 ("complete data, low risk"); Volkov → t4 ("sanctions or PEP flag").

### Recording setup

- [ ] 1080p capture; browser at 100% zoom.
- [ ] Hide the bookmarks bar; enable cursor highlight.
- [ ] Close Slack and email; silence notifications.

### Post-record

- [ ] GitHub Actions status: blocked by an account-level billing lock as of 2026-09-28 — jobs never start (annotation: "The job was not started because your account is locked due to a billing issue"). Not a repo defect; resolve at github.com/settings/billing. The GitLab pipeline remains the primary CI; the GitHub workflow config is validated locally.

## Deliverable D — Prospect FAQ

| Prospect Question | Prepared Answer |
|---|---|
| Does this integrate with Corporations Canada today? | No — not at HEAD `ccbbba4`. Registry adapters today are OpenCorporates and ComplyAdvantage; Corporations Canada is a roadmap adapter. The integration surface already exists: implement the `KycDataAdapter` interface and register it in the composite — an adapter plus key configuration, not a rearchitecture. The demo runs the zero-key synthetic path. |
| How do we know the audit trail has not been tampered with? | The evidence ledger is hash-chained and the audit log is append-only with hashed payloads (INV-004); every dossier claim must cite a ledger entry and uncited claims are mechanically stripped (INV-001 / INV-002); reports carry an HMAC-SHA256 signature verified via a public endpoint. |
| What happens on a sanctions hit — can the system auto-clear it? | No. A sanctions or PEP flag routes the case to the strongest reasoning tier and forces `pending_hitl`; INV-007 guarantees `pending_hitl` cases are never auto-approved — a named analyst must approve via `POST /cases/:id/approve`, and the route rejects non-pending cases with 409 and updates atomically. |

## Claims Guardrails (do not say on camera)

- Corporations Canada integration is not live at this HEAD (roadmap; the demo runs the zero-key synthetic path).
- 30-day beneficial-ownership discrepancy reporting is not a product feature yet (the evidence ledger is the substrate, not the feature).
- PIPEDA-specific legal review has not been performed; describe controls as mapped from the repo's privacy posture, not certified compliance.
- Do not claim "GitHub CI is green" until the account billing lock is resolved (jobs do not start); cite the GitLab pipeline or the local verification gates instead.
- CAD figures are illustrative conversions (1 EUR ≈ 1.47 CAD), not verified rates.

## Self-Check

- [x] Phase 1 scan tables emitted, with the PHASE 1 COMPLETE line.
- [x] Every metric traces to `docs/SESSION_REPORT_2026-09-28.md` §3 / `tests/evaluation/BASELINES.md`: 3.5 h → ~14 min, €380/case, F1 1.000, Macro-F1 1.000, tier agreement 1.000, low-cost ratio 0.800, 223/223, 71.59%, 60% gate, 0 vulnerabilities, 0.98 s seed.
- [x] No claim of an existing Corporations Canada adapter.
- [x] Both demo cases named exactly: "Acme Logistics BV" and "Volkov Capital Partners".
- [x] Terminology replacements applied throughout.
- [x] Loom script table has the three required columns.
- [x] Brief sections 1–6 present with the exact headings (in `CANADIAN_MARKET_IMPACT_BRIEF.md`).
- [x] Three FAQ rows present.
- [x] No emojis.
