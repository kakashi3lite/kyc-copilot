---
repo: kyc-copilot
path: /Users/kakashi3lite/kyc-copilot
doc: PLAN_WEBHOOK_DLQ_REPLAY
title: Implementation Prompt — Webhook Dead-Letter + Replay
status: draft-ready-for-implementation
updated: 2026-08-03
scope: Enterprise-grade webhook reliability: terminal failed state, delivery history, per-delivery and bulk replay, and the missing case.created event
related: [SESSION_REPORT_2026-08-03.md §7.1, SHIPPING_STATUS.md, ARCHITECTURE_CONTEXT.md §7, src/services/webhooks/*]
---

# PROMPT — Webhook Dead-Letter Queue + Replay

> Hand this prompt to an IMPLEMENTER session verbatim (plus the Load block in
> §Handoff). Follow the repo's session-start convention: `docs/CONTEXT_INDEX.md`
> → role `IMPLEMENTER` → `IS-003` (API route change) → load listed files →
> implement §Phases → run §Verification.

## 0. Mission

Turn webhook delivery into a reliable, auditable, recoverable subsystem:

1. **Dead-letter semantics** — after the retry budget is exhausted, a delivery
   lands in a terminal `failed` state with a `failedAt` timestamp, stays
   queryable, and is never silently dropped.
2. **Delivery history** — support can inspect every delivery for a webhook
   (pending / delivered / failed) with error detail.
3. **Replay** — support can retry a single failed delivery, or all failed
   deliveries for a webhook, without re-running the underlying case.
4. **Companion fix** — enqueue the currently-missing `case.created` webhook
   event (documented gap since before this plan).

Existing retry/backoff behavior (worker `delays = [1 s, 4 s, 16 s]`, max 3
attempts → `failed`) is preserved; this plan adds the **observability and
recovery layer** around it, plus the missing event.

## 1. Current state (verified 2026-08-03 — do not re-litigate)

| # | Finding | Evidence |
|---|---|---|
| W1 | `webhookDeliveries` has `id, webhookId, tenantId, event, payload, attempts (default 0), status (default "pending"), nextAttemptAt, lastError, timestamps`; index on `(tenant_id)` and `(status)` | `src/db/schema.ts:143-154` |
| W2 | `deliverWebhook` signs + POSTs, then sets `attempts+1`, `status: delivered|pending`, `lastError` | `src/services/webhooks/dispatcher.ts` |
| W3 | `processPendingWebhooks` picks pending due rows (limit 50); on failure backoff `[1 s, 4 s, 16 s]`, status `failed` when `attempts >= 2` | `src/services/webhooks/worker.ts` |
| W4 | `enqueueWebhookEvent` inserts delivery rows and wakes the `webhook-deliverer` queue (trigger added this ship) | `src/services/webhooks/dispatcher.ts` |
| W5 | Routes: `POST /webhooks`, `GET /webhooks`, `POST /webhooks/:id/test`; all webhook routes gated `growth+` plan | `src/api/routes/webhooks.ts` |
| W6 | `case.created` is **never enqueued** (only completed/pending_hitl/failed/approved) | `src/api/routes/cases.ts` (create handler) |
| W7 | `failed` status has **no timestamp** and **no replay path** — failed deliveries are terminal but invisible/unrecoverable | `src/db/schema.ts` |

## 2. Design decisions (encode these, do not re-open)

- **D1 — Max attempts constant:** extract `const MAX_ATTEMPTS = 3` and have the
  worker use it (currently the `attempts >= 2` inline check). Semantics: 3
  total attempts (1 initial + 2 retries) then `failed`.
- **D2 — Dead-letter marker:** add `failedAt: timestamp with timezone, nullable`
  to `webhookDeliveries`. Worker sets it when transitioning to `failed`; clears
  on replay. A `delivered` delivery must never be replayed.
- **D3 — Replay is a status reset, never a re-run:** replay sets
  `status: "pending"`, `attempts: 0`, `nextAttemptAt: now`, `failedAt: null`,
  keeps the original `payload`, and enqueues the deliverer trigger job. The
  underlying case/graph is untouched.
- **D4 — API surface (all `growth+`, matching webhook gating):**
  - `GET /webhooks/:id/deliveries?status=&limit=` → history (status filter
    optional, limit ≤ 100, newest first)
  - `POST /webhooks/:id/deliveries/:deliveryId/replay` → 202 + `{replayed: 1}`
  - `POST /webhooks/:id/replay` → requeues all `failed` deliveries for the
    webhook → 202 + `{replayed: N, skipped: M}`
  - Errors: `404` missing webhook or delivery; `409` replaying a non-failed
    delivery (D3); `403` starter plan.
- **D5 — `case.created` enqueue:** in the `POST /cases` handler, call
  `enqueueWebhookEvent(tenantId, "case.created", { caseId, status: "queued" })`
  after the insert (both sync and async paths). It is a no-op when no webhook
  subscribes to `case.created` (existing guard in `enqueueWebhookEvent`).
- **D6 — No destructive endpoints in v1:** no DELETE for deliveries; retention
  is a future cron (see §Future).

## 3. Invariants (will NOT break)

- INV-006 (HMAC-signed delivery) preserved — replay uses the same
  `deliverWebhook` path.
- Backoff/retry behavior unchanged for the happy + transient-failure paths.
- `growth+` plan gate on all webhook endpoints.
- `npm run typecheck` (strict) green; `npm run test` green, coverage ≥ 30% lines.
- `docker build .` green.

## 4. Phases

### Phase A — Schema + migration

**Files:** `src/db/schema.ts`, new drizzle migration (run `npm run db:generate`, then verify `npm run db:migrate` **or the programmatic migrator** `node dist/src/db/migrate.js` per the runbook note in SESSION_REPORT §8.1)

1. Add `failedAt: timestamp("failed_at", { withTimezone: true })` (nullable) to `webhookDeliveries`.
2. Optionally add `lastHttpStatus: integer` (nullable) — set in `deliverWebhook`
   from `response.status`; useful for support triage. *(low cost, high value)*.
3. Ensure the migration applies idempotently.

### Phase B — Worker dead-letter

**Files:** `src/services/webhooks/worker.ts`

1. Add `const MAX_ATTEMPTS = 3`.
2. When marking `failed`, also set `failedAt: new Date()`. Keep
   `nextAttemptAt` backoff for pending retries.

### Phase C — Replay + history routes

**Files:** `src/api/routes/webhooks.ts`, `src/services/webhooks/replay.ts` *(new)*

1. `replay.ts`: `replayDelivery(deliveryId): Promise<"replayed" | "not_failed" | "missing">`
   and `replayAllForWebhook(webhookId): Promise<{replayed: number}>` — both do
   the D3 reset and `webhookDelivererQueue.add("deliver", {})` (import the
   queue from `dispatcher.ts` — it is module-private today; export it or add a
   small `enqueueDeliveryTrigger()` helper there).
2. Routes per D4, reusing the existing `problem()` helper and `getAuth()`;
   tenant-scope every query by `tenantId`.

### Phase D — `case.created` enqueue

**Files:** `src/api/routes/cases.ts`

1. After `writeAuditLog(... case.created ...)` in the create handler, add
   `await enqueueWebhookEvent(auth.tenantId, "case.created", { caseId, status: "queued" });`
   (before the sync/async branch — event fires on creation regardless).

### Phase E — Tests

**Files (new/extended):**
- `tests/unit/services/webhooks-replay.test.ts` *(new)*: replay resets
  status/attempts/nextAttemptAt/failedAt; `not_failed` for delivered; `missing`
  for unknown id (mock db via the existing patterns).
- `tests/integration/api/webhooks.test.ts` *(new, model on auth.test.ts mocks)*:
  - `GET /webhooks/:id/deliveries` returns history (tenant-scoped)
  - replay failed → 202, delivery back to `pending`, trigger enqueued
  - replay delivered → 409
  - replay missing webhook/delivery → 404
  - starter plan → 403
  - `case.created` row appears in deliveries for a subscribing webhook after `POST /cases`
- Extend `tests/unit/nodes/…` only if the worker `MAX_ATTEMPTS` change needs coverage.

### Phase F — Docs

- **Q1** `docs/DECISIONS.md` → **ADR-015 "Webhook dead-letter + replay (status-reset recovery)"** (records D1–D6).
- **Q2** `docs/ARCHITECTURE_CONTEXT.md` → §7 API table (3 new endpoints), §6 note on `failedAt`.
- **Q3** `docs/SHIPPING_STATUS.md` → move webhooks row to "ready" incl. replay; note `case.created` now enqueued.

## 5. Edge cases

| Edge case | Handling |
|---|---|
| Replay a `delivered` delivery | `409` (D3 — never re-deliver a success) |
| Replay a `pending` delivery mid-backoff | `409` (not terminal) |
| Webhook deleted / inactive | `404` on webhook-scoped routes; existing rows retained |
| Replay while deliverer busy | Enqueued trigger job → worker drains (idempotent reset) |
| `case.created` with no subscriber | No-op (existing guard) |
| Replay with a now-dead endpoint | Re-enters backoff → `failed` again with new `failedAt`; repeatable forever |
| Payload PII | Replay reuses stored `payload` — never re-fetches from the case (no new decryption) |
| Large history | `limit ≤ 100` + status filter (D4) |
| Retention | Out of scope v1 (D6); future cron |

## 6. Verification checklist

1. `npm run typecheck` green
2. `npm run build` → `dist/src/index.js`
3. `npm run test` green, coverage ≥ 30% lines, no skipped tests
4. `docker build .` green
5. Migration applies idempotently (programmatic migrator per runbook)
6. Live (server + a deliberately dead webhook endpoint):
   - register webhook → create case → delivery rows appear
   - endpoint returns 500 → after ~3 attempts delivery is `failed` with `failedAt` set
   - `GET /webhooks/:id/deliveries?status=failed` lists it with `lastError`
   - point the webhook URL at a healthy listener (or `POST /webhooks/:id/test`) →
     `POST /webhooks/:id/deliveries/:id/replay` → 202 → delivery becomes `delivered`
   - replay same id again → 409
   - `POST /webhooks/:id/replay` → 202 with `{replayed: N}`
   - new case with a `case.created`-subscribing webhook → `case.created` delivery row created
7. Zero-key demo regression: Acme → completed, Volkov → pending_hitl (unchanged)

## 7. Future (post-v1, note only)

- Delivery **retention/cleanup cron** (D6) + archival to S3.
- **Alerting**: expose `failed` count in `/health` or a webhook-failure metric.
- **Idempotency keys** per tenant+event+caseId to collapse duplicate deliveries.
- **Signed replay bundles** for auditors (delivery log export).

## 8. Handoff block

```markdown
- Repo: /Users/kakashi3lite/kyc-copilot @ main
- Load: docs/CONTEXT_INDEX.md → role IMPLEMENTER → IS-003 →
  docs/PLAN_WEBHOOK_DLQ_REPLAY.md → src/api/routes/webhooks.ts →
  src/services/webhooks/dispatcher.ts → src/services/webhooks/worker.ts →
  src/db/schema.ts → src/api/routes/cases.ts
- Task: implement Phases A–F per §4; run §6 verification
- Do NOT change: INV-006 signature scheme, backoff/retry happy path, plan gates
- Decision anchors: D1–D6 (§2) — do not re-open without an ADR
- Note: use the programmatic migrator (not drizzle-kit CLI) on this machine (SESSION_REPORT §8.1)
- Verify: npm run typecheck && npm run test && docker build .
```
