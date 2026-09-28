---
repo: kyc-copilot
path: /Users/kakashi3lite/kyc-copilot
doc: CANADIAN_MARKET_IMPACT_BRIEF
title: Canadian Market Impact Brief — one-page proof of work (HEAD ccbbba4)
status: current
updated: 2026-09-28
scope: Prospect-facing one-pager mapping verified repo capabilities to Canadian requirements (PCMLTFA / FINTRAC / PIPEDA)
related:
  - DEMO_PACKAGE_CANADA_2026-09-28.md
  - SESSION_REPORT_2026-09-28.md
  - tests/evaluation/BASELINES.md
  - SECURITY.md
---

# Canadian Market Impact Brief

> KYC Copilot — agentic corporate due diligence for Canadian reporting entities
> (MSBs, PSPs, fintechs, wealth managers). All figures are verified against
> repository HEAD `ccbbba4` (2026-09-28); CI evidence: GitLab pipeline #13
> (`e701bd6`). CAD conversions are illustrative at 1 EUR ≈ 1.47 CAD and are
> not verified rates.

## 1. The Problem (Canadian Context)

- Canadian reporting entities — MSBs, PSPs, fintechs, and wealth managers — run corporate EDD largely by hand: the measured baseline is ~3.5 hours per case, with copy-paste registry research and unverifiable write-ups.
- FINTRAC's expanded beneficial-ownership reporting obligations, effective 2025-10-01, include a 30-day discrepancy reporting window — documentation quality and timing now carry direct regulatory weight.
- Measured cost of manual review: ~€380 of analyst time per case (approximately CAD $560 at 1 EUR ≈ 1.47 CAD; conversion illustrative, not verified).

## 2. What KYC Copilot Does

```text
Case Intake (company · reg no. · jurisdiction)
    ↓
Registry + Sanctions/PEP Lookup  ←→  Corporations Canada (roadmap adapter)
    ↓ (if incomplete)
Browser Fallback (Playwright)
    ↓
Entity Resolution + RAG-Graph Retrieval
    ↓
KYT Typology Check ($0.00 marginal LLM cost)
    ↓
Dossier Drafting (5-tier cost routing)
    ↓
Guardrail — uncited claims stripped
    ↓
[Low Risk]   → Auto-complete → Signed report (HMAC-SHA256)
[High Risk]  → pending_hitl  → Named analyst approves → Signed report
```

## 3. Quantified Impact

| Metric | Manual Baseline | With KYC Copilot | Canadian Relevance |
|---|---|---|---|
| Time per corporate EDD | ~3.5 hours | ~14 minutes | Same analyst capacity covers more FINTRAC-obligated files |
| Analyst cost per case | ~€380 (≈ CAD $560 at 1 EUR ≈ 1.47 CAD; conversion illustrative) | ~€380 of analyst time avoided per case (dashboard ROI card) | Direct opex reduction for Canadian reporting entities |
| Evidence trail | Unverifiable write-ups; PDFs with no integrity | Every claim cites a hash-chained ledger entry; reports HMAC-SHA256-signed with a public verify endpoint | Exam-ready documentation substrate for FINTRAC |
| UBO extraction | Manual registry chasing | Automated registry-officer extraction with soft-degrade; ownership never invented (null when unknown) | Supports FINTRAC beneficial-ownership data quality; zero-key demo returns no UBOs by design |
| Human review scope | Ad-hoc high-risk review | Rule-based escalation; pending_hitl locked until a named analyst approves (INV-007) | Clear four-eyes trail for high-risk files |

## 4. Technical Proof

- Entity-resolution F1 1.000 (gate > 0.90) — `npm run bench:eval` — evidence: [job 16772200919 artifacts](https://gitlab.com/kakashi3litez/kyc-copilot/-/jobs/16772200919/artifacts/download) (`latest.json`)
- KYT typology Macro-F1 1.000 (gate > 0.85) — same artifact
- Tier agreement 1.000 — same artifact
- Low-cost tier ratio 0.800 (target ≥ 0.60) — same artifact
- Full suite 223/223 tests, 38 files — `LLM_TIER_PRIMARY=t0 npm run test` — evidence: [job 16772200923 artifacts](https://gitlab.com/kakashi3litez/kyc-copilot/-/jobs/16772200923/artifacts/download) (`coverage/`)
- Line coverage 71.59% vs the 60% gate — `npm run test` (thresholds enforced) — same artifact
- Dependency audit 0 vulnerabilities (from 6, incl. 1 high) — `npm audit` — evidence: [job 16772200922](https://gitlab.com/kakashi3litez/kyc-copilot/-/jobs/16772200922) (job log)
- Container gate EXIT 0 — `docker compose run --rm test`

All gates are recorded in `tests/evaluation/BASELINES.md` and `docs/SESSION_REPORT_2026-09-28.md` §3. GitLab reference pipeline: [#13](https://gitlab.com/kakashi3litez/kyc-copilot/-/pipelines/2888512747) (`e701bd6`) — all ten automated jobs green.

## 5. Canadian Compliance Alignment

| Canadian Requirement | How KYC Copilot Addresses It |
|---|---|
| PCMLTFA client verification | Entity intake plus registry screening and sanctions/PEP checks with per-claim evidence citations; identity fields AES-256-GCM encrypted at rest and masked in the UI. Corporations Canada integration is roadmap; today's demo uses the zero-key synthetic path. |
| FINTRAC beneficial ownership | Automated UBO extraction from registry officers (real-key path); ownership percentage coerced or null — never invented (ADR-013 / ADR-014). Zero-key demo returns no UBOs by design. |
| 30-day discrepancy reporting | Not implemented as a product feature at HEAD `ccbbba4` (roadmap). The hash-chained evidence ledger and timestamps are the substrate for it. Do not claim this capability on camera. |
| 5-year recordkeeping | Cases, evidence, and hash-chained audit logs persist in PostgreSQL; signed PDF/JSON reports are exportable; retention configuration is operator policy. |
| Risk assessment | Rule-based escalation (sanctions, PEP, high risk, partial data) plus the KYT typology classifier when transaction data exists; high-risk cases lock at pending_hitl for named-analyst approval (INV-007). |

## 6. Demo Reproducibility (for the prospect's technical team)

Verified on HEAD `ccbbba4` (`origin/main` == `gitlab/main`, working tree clean): Acme Logistics BV routes to `completed` and Volkov Capital Partners routes to `pending_hitl`, both reproduced end-to-end on this commit. The zero-key demo uses the seeded API key printed by `npm run db:seed`. GitLab commit: https://gitlab.com/kakashi3litez/kyc-copilot/-/commit/ccbbba4

```bash
npm run db:migrate    # 6 migrations; webhook-DLQ columns present
npm run db:seed       # exits in ~0.98s (fixed); prints the demo API key
npm run demo          # compose service is `postgres` (fixed), not `db`

# After the server reports "kyc-copilot started":
curl -s http://localhost:3000/health          # {"status":"ok", db + redis true}

curl -s -X POST 'http://localhost:3000/cases?sync=true' \
  -H "Authorization: Bearer kc_live_demo0000000000000000000000" \
  -H "Content-Type: application/json" \
  -d '{"companyName":"Acme Logistics BV","registrationNumber":"NL12345678","jurisdiction":"NL"}'
# -> {"status":"completed"}

curl -s -X POST 'http://localhost:3000/cases?sync=true' \
  -H "Authorization: Bearer kc_live_demo0000000000000000000000" \
  -H "Content-Type: application/json" \
  -d '{"companyName":"Volkov Capital Partners","registrationNumber":"CY98765432","jurisdiction":"CY"}'
# -> {"status":"pending_hitl"}
```

## 7. GitLab Artifact Map

| Deliverable | GitLab Location | URL Pattern |
|---|---|---|
| Loom Script | Wiki: Demo Package / Loom Script | https://gitlab.com/kakashi3litez/kyc-copilot/-/wikis/demo-package/loom-script |
| Impact Brief | Wiki: Demo Package / Canadian Impact Brief | https://gitlab.com/kakashi3litez/kyc-copilot/-/wikis/demo-package/canadian-impact-brief |
| Readiness Table | Repo: `docs/CANADIAN_READINESS.md` | https://gitlab.com/kakashi3litez/kyc-copilot/-/blob/main/docs/CANADIAN_READINESS.md |
| Demo Runbook | Issue: Demo Day Runbook — Canadian Market | https://gitlab.com/kakashi3litez/kyc-copilot/-/issues/<N> (number assigned on creation) |
| Test Evidence | CI artifacts: pipeline #13 (`e701bd6`) | https://gitlab.com/kakashi3litez/kyc-copilot/-/jobs/16772200919/artifacts/download (eval) and https://gitlab.com/kakashi3litez/kyc-copilot/-/jobs/16772200923/artifacts/download (coverage) |
