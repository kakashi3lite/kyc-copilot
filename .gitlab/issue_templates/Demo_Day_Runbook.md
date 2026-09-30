---
name: Demo Day Runbook
title: "Demo Day Runbook — Canadian Market"
labels: "demo, canada, fintrac, priority::high"
---

<!-- Track this runbook as an Issue. Tick items as they complete. -->

## Environment

- [ ] Review `.env.example`: `DATABASE_URL`, `REDIS_URL`, `ENCRYPTION_KEY`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `API_KEY_LOOKUP_SECRET`, `REPORT_SIGNING_KEY` (empty = unsigned reports), `APP_BASE_URL`.
- [ ] Hostnames understood: compose uses `postgres` / `redis`; host-run dev uses `localhost` defaults (see the `.env.example` note).
- [ ] Postgres quirk: Homebrew 16.14 owns `localhost:5432` for host-run dev — the demo uses the Homebrew `kyc` database (migrated 6/6 + seeded). Docker Postgres serves the compose network only.

## Seed + start

- [ ] `npm run db:migrate` completes (6 migrations).
- [ ] `npm run db:seed` exits in ~0.98s.
- [ ] `npm run demo` uses compose service `postgres` (not `db`).

## Pre-record verification

- [ ] curl both cases: Acme Logistics BV → `completed`; Volkov Capital Partners → `pending_hitl`.
- [ ] Router logs: Acme → t2 ("complete data, low risk"); Volkov → t4 ("sanctions or PEP flag").

## Recording setup

- [ ] 1080p capture; browser at 100% zoom; bookmarks bar hidden; cursor highlight on.
- [ ] Slack and email closed; notifications silenced.

## Post-record

- [ ] GitLab pipeline green at `v0.9.0-demo-canada` (frozen demo snapshot) with all gate jobs run (typecheck, unit-test, eval-golden, design-system-gates, full-gate, build-ts, docker-build — see `docs/CANADIAN_READINESS.md` section 3).
- [ ] Artifacts downloadable: `eval-golden` → `tests/evaluation/reports/latest.json`; `design-system-gates` → `design-system-artifacts/` + `design-system/visual-regression/current/`; `full-gate` → `coverage/`.
- [ ] Release tagged at `v0.9.0-demo-canada` (demo snapshot frozen 2026-09-30) with notes linking the Wiki.

## Prospect FAQ (reference)

| Prospect Question | Prepared Answer |
|---|---|
| Does this integrate with Corporations Canada today? | No — not at this HEAD. Registry adapters today are OpenCorporates and ComplyAdvantage; Corporations Canada is a roadmap adapter. The integration surface already exists: implement the `KycDataAdapter` interface and register it in the composite — an adapter plus key configuration, not a rearchitecture. The demo runs the zero-key synthetic path. |
| How do we know the audit trail has not been tampered with? | The evidence ledger is hash-chained and the audit log is append-only with hashed payloads (INV-004); every dossier claim must cite a ledger entry and uncited claims are mechanically stripped (INV-001 / INV-002); reports carry an HMAC-SHA256 signature verified via a public endpoint. |
| What happens on a sanctions hit — can the system auto-clear it? | No. A sanctions or PEP flag routes the case to the strongest reasoning tier and forces `pending_hitl`; INV-007 guarantees `pending_hitl` cases are never auto-approved — a named analyst must approve via `POST /cases/:id/approve`, and the route rejects non-pending cases with 409 and updates atomically. |

## Linked Issues

- Parent: Demo Package — Canadian Market
- Blocked by: none
- Relates to: #<commit-issue> (four demo blockers, fixed in commit `14d37fe`)

## Labels

`demo`, `canada`, `fintrac`, `priority::high`

> Updated from `ccbbba4` on 2026-09-30 — the design system and CI gates landed after the original demo commit.
