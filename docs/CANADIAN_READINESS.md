---
repo: kyc-copilot
path: /Users/kakashi3lite/kyc-copilot
doc: CANADIAN_READINESS
title: Canadian Readiness — FINTRAC / PCMLTFA gap analysis
status: current
updated: 2026-09-28
scope: Honest gap analysis mapping verified capabilities to Canadian requirements (HEAD e701bd6); no capability is claimed beyond HEAD
related:
  - DEMO_PACKAGE_CANADA_2026-09-28.md
  - CANADIAN_MARKET_IMPACT_BRIEF.md
  - SESSION_REPORT_2026-09-28.md
  - tests/evaluation/BASELINES.md
---

# Canadian Readiness — FINTRAC / PCMLTFA

> Figures trace to `docs/SESSION_REPORT_2026-09-28.md` section 3 and
> `tests/evaluation/BASELINES.md`. Currency: 1 EUR ≈ 1.47 CAD (illustrative).
> CI evidence: pipeline #13 at `e701bd6` — see section 3.

## 1. Regulatory Mapping

| Canadian Requirement | Current Implementation | Gap | Roadmap Phase |
|---|---|---|---|
| PCMLTFA client verification | Entity intake (company, registration number, jurisdiction) plus registry screening and sanctions/PEP checks with per-claim evidence citations; PII AES-256-GCM at rest, masked in the UI | Corporations Canada is not an adapter at HEAD (OpenCorporates + ComplyAdvantage only); the zero-key demo path is synthetic | Phase 2 |
| FINTRAC beneficial ownership | Officers-endpoint UBO extraction with soft-degrade; ownership percentage coerced or null — never invented (ADR-013 / ADR-014) | The real-key path requires a provider key; the zero-key demo returns no UBOs by design | Phase 2 |
| 30-day discrepancy reporting | Not implemented. The hash-chained evidence ledger and timestamps are the substrate | Discrepancy detection and reporting workflow | Phase 2 |
| 5-year recordkeeping | Cases, evidence, and hash-chained audit logs persist in PostgreSQL; signed PDF/JSON export | Retention policy configuration is operator-owned; no automated retention clock at HEAD | Ops / Phase 2 |
| Risk assessment | Rule-based escalation (sanctions, PEP, high risk, partial data) plus the KYT typology check when transaction data exists; `pending_hitl` locked to a named analyst (INV-007) | No Canadian transaction data source connected | Phase 2/3 |

## 2. Registry Adapter Gap Analysis

| Adapter Needed | Interface Requirements | Auth | Rate Limits | Data Schema |
|---|---|---|---|---|
| CorporationsCanadaAdapter | Implement `KycDataAdapter.lookup(input: EntityInput): Promise<ApiCompanyData>` (`src/services/kyc-data/adapter.ts`); register in `CompositeKycDataAdapter`; injected via `ApiLookupDependencies` (`src/graph/nodes/api-lookup.ts`) | Env-key pattern mirroring `COMPLY_ADVANTAGE_API_KEY` | Follow the existing resilience pattern: CircuitBreaker + `withRetry` + `AbortSignal` timeout + input sanitization (see `opencorporates.ts`) | Map into the Zod-validated `ApiCompanyData` shape (`legalName`, `registrationNumber`, `jurisdiction`, `status`, `ubos[{name, verified, ownershipPct}]`, `sanctions`, `pep`, `sourceUrl`, `completeness`) |

## 3. CI/CD Evidence

Pipeline #13: https://gitlab.com/kakashi3litez/kyc-copilot/-/pipelines/2888512747 (commit `e701bd6`). All ten automated jobs green; `deploy-production` remains a manual, key-gated job (ADR-024). This is the first pipeline in which the full gate ran: earlier pipelines skipped every gate job due to an over-broad docs-skip rule (fixed in `e701bd6`; see the commit message and `.gitlab-ci.yml` history note).

| Gate | Command | CI Artifact Path | Status |
|---|---|---|---|
| Typecheck | `npm run typecheck` | [job 16772200917](https://gitlab.com/kakashi3litez/kyc-copilot/-/jobs/16772200917) (log) | pass |
| Unit 159/159 | `npm run test:unit` | [job 16772200918](https://gitlab.com/kakashi3litez/kyc-copilot/-/jobs/16772200918) (log) | pass |
| Evaluation 24/24 — entity F1 1.000 (gate >0.90), KYT Macro-F1 1.000 (gate >0.85), tier agreement 1.000, low-cost ratio 0.800 | `npm run test:eval` + `npm run bench:eval` | [job 16772200919 artifacts](https://gitlab.com/kakashi3litez/kyc-copilot/-/jobs/16772200919/artifacts/download) (`latest.json`, `BASELINES.md`) | pass |
| Full suite 223/223, coverage 71.59% lines (gate 60%) | `npm run test` | [job 16772200923 artifacts](https://gitlab.com/kakashi3litez/kyc-copilot/-/jobs/16772200923/artifacts/download) (`coverage/` + cobertura report) | pass |
| Compose gate | `docker compose run --rm test` | local / CI-parity gate (no artifact) | pass on `ccbbba4` |
| Dependency audit — 0 vulnerabilities | `npm audit` | [job 16772200922](https://gitlab.com/kakashi3litez/kyc-copilot/-/jobs/16772200922) (log) | pass |
| SAST | Semgrep template job | [job 16772200920](https://gitlab.com/kakashi3litez/kyc-copilot/-/jobs/16772200920) (SAST report artifact) | pass |
| Secret detection | GitLab Secret Detection template | [job 16772200921](https://gitlab.com/kakashi3litez/kyc-copilot/-/jobs/16772200921) (report artifact) | pass |
| Container build | `docker build .` | [job 16772200925](https://gitlab.com/kakashi3litez/kyc-copilot/-/jobs/16772200925) (image pushed to the project registry) | pass |

Note: the project is private — artifact links require a member account. Downloads were verified working with an authenticated session on 2026-09-28.

## 4. Security Posture

| Control | Implementation | Evidence |
|---|---|---|
| PII at rest | AES-256-GCM field-level encryption; masked displays only | `src/services/encryption/at-rest.ts`, `SECURITY.md` section 1 |
| PII in LLM prompts | Deterministic pseudonym redaction (providers never see real identity data) | `src/services/llm/pii-redactor.ts` |
| Report signing | HMAC-SHA256 content signature + public verification endpoint | `src/services/reports/signer.ts`, ADR-017 |
| Audit ledger | Append-only, hash-chained audit log for every state-changing action (INV-004) | `src/services/audit/logger.ts` |
| Evidence ledger | Hash-chained per-case evidence; uncited claims stripped (INV-001 / INV-002) | `src/graph/nodes/guardrail.ts`, `src/db/schema.ts` |
| Tenant isolation | All graph queries scoped by `tenantId`; cross-tenant federation is opt-in (G3) | `src/services/kyc-data/graph-query.ts`, migration 0004 |
| Dependency scanning | `npm audit` 0 vulnerabilities; Semgrep SAST + Secret Detection in CI | pipeline #13 jobs |

## 5. Next Actions

- [ ] Implement `CorporationsCanadaAdapter` (Phase 2) — interface, env key, resilience pattern, schema mapping per section 2
- [ ] Add 30-day beneficial-ownership discrepancy detection and reporting (Phase 2)
- [ ] Validate ComplyAdvantage Canadian sanctions/PEP list coverage
- [ ] PIPEDA legal review of the privacy posture (controls currently mapped from the GDPR-era implementation)
- [ ] Configure the retention policy for the 5-year recordkeeping requirement
- [ ] Tag the demo release (`v0.9.0-demo-canada`) with notes linking the Wiki pages
