---
repo: kyc-copilot
path: /Users/kakashi3lite/kyc-copilot
doc: DR_RUNBOOK
title: Disaster Recovery & Backup Runbook — Fly Postgres (DORA evidence)
status: current
updated: 2026-08-13
owner: Principal AI Architect / Ops
related: [INCIDENT_RUNBOOK.md, scripts/dr/restore-drill.sh, PLAN_PRODUCTION_READINESS.md §Phase 5]
---

# Disaster Recovery & Backup Runbook

> DORA (EU) 2022/2554, applied since 17 Jan 2025, requires financial-entity
> customers to evidence ICT recovery capability (Art. 11 — protection; Art. 12 —
> detection/response/recovery, including documented backup policy and tested
> restoration). This runbook is that evidence for KYC Copilot's hosted stack.

## 1. Recovery objectives (RPO/RTO)

| Metric | Target | Basis |
|---|---|---|
| RPO (data loss window) | ≤ 24 h automatic · **≤ 5 min via PITR** | Fly Postgres daily automatic backups + continuous WAL archiving |
| RTO (time to restored service) | ≤ 30 min | restore → `restore-drill.sh` → traffic cutover |
| Backup retention | 7 daily + PITR window | Fly default; adjust per customer SLA |

## 2. What is backed up

| Asset | Mechanism | Cadence |
|---|---|---|
| Postgres (all 15 tables: cases, evidence, graph, billing, webhooks) | Fly Postgres automatic backups + PITR (wal-g based) | Daily automatic; on-demand before deploys |
| Redis (queues, rate limits, semantic LLM cache) | **Replayable, not restored** — BullMQ job source is Postgres; cache re-warms | n/a (rebuild) |
| Object storage / volume (`/app/data`) | Fly volume snapshots | Weekly (snapshot); content is transient |
| Config / infra-as-code | Git (fly.toml, Terraform) | Every commit |

## 3. Full restore procedure (runbook)

> Restore NEVER targets production directly. Restore to a TEMPORARY database,
> verify with the drill, then promote.

1. **Create an on-demand backup** (pre-deploy discipline):
   ```bash
   flyctl postgres backup create --app kyc-copilot
   ```
   *Verify your exact `flyctl postgres` subcommand syntax with `flyctl postgres --help` — Fly's CLI changes between majors; the drill below is the guardrail that catches any drift.*

2. **Restore the latest backup to a temporary database:**
   ```bash
   flyctl postgres restore kyc-copilot-db kyc-drill-restore
   ```
   (or restore a specific backup id / point-in-time via the Fly dashboard).

3. **Run the restore drill against the temporary DB** (proves migrations apply
   and the schema is complete, incl. migration `0005` DLQ columns):
   ```bash
   RESTORE_DATABASE_URL="postgres://<user>:<pass>@<host>:5432/kyc-drill-restore" \
     bash scripts/dr/restore-drill.sh
   ```
   Expected output ends with `✓ DRILL PASSED` and appends an evidence line to
   `docs/dr-drill-log.txt`.

4. **Promote / cut over** (if this is a real disaster):
   - Stop writes on the primary, restore to the production database name, or
     re-point `DATABASE_URL` in `infra/fly-secrets.sh` and re-deploy.
   - Run the E2E lifecycle against the recovered environment
     (`docker compose run --rm test` locally is a good proxy).

5. **Discard the temporary DB** after the drill.

## 4. The drill (evidence)

`scripts/dr/restore-drill.sh` performs, against the TEMPORARY database:
1. `npm run db:migrate` (the app's own release command) — proves migrations apply cleanly.
2. Existence of all 15 production tables.
3. Presence of `webhook_deliveries.failed_at` + `last_http_status` (migration 0005).

**Cadence:** run the drill **monthly** (and always after a schema/migration change)
and retain `docs/dr-drill-log.txt` as DORA evidence. An automated GitLab
scheduled job for this is the next ops item.

## 5. DORA mapping

| DORA article | This runbook |
|---|---|
| Art. 11 (protection & prevention) | Backups + PITR + encryption at rest (AES-256-GCM) |
| Art. 12 (detection/response/recovery) | Incident runbook + restore drill + `/health` probes |
| Art. 28–30 (ICT third-party) | DPA pack (`docs/DPA_PACK.md`) for Fly/Upstash/R2 |

## 6. Failure modes

| Scenario | Handling |
|---|---|
| Backup listing empty | Alert ops immediately; check Fly Postgres backup config; this runbook's evidence is void until a drill passes |
| Restore to temp DB fails | Investigate disk/credentials; do NOT promote |
| Drill fails (missing table/column) | The backup predates a migration — restore a newer backup or apply migrations before promoting |
| PITR window exceeded | Accept RPO breach, document, restore nearest available |
