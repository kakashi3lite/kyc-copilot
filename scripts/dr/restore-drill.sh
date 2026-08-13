#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Restore Drill — verify a restored Fly Postgres backup (DORA evidence)
#
# DORA (EU) 2022/2554 (Art. 11/12) requires documented, TESTED ICT recovery.
# This drill proves that a restored database is usable:
#   1. applies the app's own migrations (idempotent) to the restored DB
#   2. verifies all 15 production tables exist
#   3. verifies the DLQ columns from migration 0005 (failed_at, last_http_status)
#   4. records PASS/FAIL + timestamp in docs/dr-drill-log.txt (evidence)
#
# The script NEVER touches the production database. Point RESTORE_DATABASE_URL
# at the TEMPORARY restored database (see docs/DR_RUNBOOK.md for the flyctl
# backup/restore steps).
#
# Usage:
#   RESTORE_DATABASE_URL="postgres://user:pass@host:5432/kyc-drill" \
#     bash scripts/dr/restore-drill.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

RESTORE_DATABASE_URL="${RESTORE_DATABASE_URL:-}"
LOG_FILE="${LOG_FILE:-docs/dr-drill-log.txt}"

if [[ -z "$RESTORE_DATABASE_URL" ]]; then
  echo "✗ RESTORE_DATABASE_URL is required (point it at the TEMPORARY restored DB)."
  echo "  See docs/DR_RUNBOOK.md for the full procedure."
  exit 1
fi

MASKED_URL="${RESTORE_DATABASE_URL%%@*}@***"
echo "🔎 Restore drill — target: ${MASKED_URL}"
command -v node >/dev/null || { echo "✗ node not found (required for verification)"; exit 1; }

echo "0) Waiting for the restored database to accept connections..."
DATABASE_URL="$RESTORE_DATABASE_URL" node <<'EOF'
const { Client } = require("pg");
(async () => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 1500 });
      await client.connect();
      await client.end();
      process.exit(0);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  process.exit(1);
})().catch(() => process.exit(1));
EOF
READY_RC=$?
if [ "$READY_RC" -ne 0 ]; then echo "✗ restored DB never became ready within 15s"; exit 1; fi
echo "   database ready"

echo "1) Applying app migrations to the restored DB (idempotent)..."
DATABASE_URL="$RESTORE_DATABASE_URL" npm run db:migrate >/tmp/dr-drill-migrate.log 2>&1 \
  || { echo "✗ migrations failed on restored DB"; tail -5 /tmp/dr-drill-migrate.log; exit 1; }
echo "   migrations OK"

echo "2) Verifying schema + DLQ columns..."
VERIFY_OUTPUT="$(DATABASE_URL="$RESTORE_DATABASE_URL" node <<'EOF'
const { Client } = require("pg");

const expectedTables = [
  "tenants", "users", "cases", "evidence", "usage", "audit_logs",
  "webhooks", "webhook_deliveries", "graph_entities", "graph_edges",
  "case_entities", "plans", "stripe_events", "failed_cases", "amld6_articles",
];
// Migration 0005 (webhook DLQ) columns — must exist or the restore is stale.
const expectedCols = { webhook_deliveries: ["failed_at", "last_http_status"] };

(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const missing = [];

  const tables = await client.query("select tablename from pg_tables where schemaname='public'");
  const have = new Set(tables.rows.map((r) => r.tablename));
  for (const name of expectedTables) if (!have.has(name)) missing.push(`table ${name}`);

  for (const [table, cols] of Object.entries(expectedCols)) {
    const colsRes = await client.query(
      "select column_name from information_schema.columns where table_name = $1",
      [table],
    );
    const haveCols = new Set(colsRes.rows.map((r) => r.column_name));
    for (const col of cols) if (!haveCols.has(col)) missing.push(`${table}.${col}`);
  }

  await client.end();
  if (missing.length > 0) {
    console.log(`MISSING: ${missing.join(", ")}`);
    process.exit(1);
  }
  console.log(`schema OK — ${expectedTables.length} tables + DLQ columns present`);
})().catch((error) => { console.error(String(error)); process.exit(1); });
EOF
)"
RC=$?
echo "   ${VERIFY_OUTPUT}"
if [ "$RC" -ne 0 ]; then
  echo "✗ DRILL FAILED — see docs/DR_RUNBOOK.md"
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) restore-drill FAIL (${MASKED_URL})" >> "$LOG_FILE"
  exit 1
fi

echo "✓ DRILL PASSED"
mkdir -p "$(dirname "$LOG_FILE")"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) restore-drill PASS (${MASKED_URL}) — schema + migrations verified" >> "$LOG_FILE"
