---
repo: kyc-copilot
path: /Users/kakashi3lite/kyc-copilot
doc: PLAN_MVP_SHIP
title: MVP Shipping Plan — Reliable Zero-Key End-to-End
status: approved-for-implementation
updated: 2026-08-03
scope: Reliable MVP/demo · conservative changes · deterministic low-risk completion
related: [ARCHITECTURE_CONTEXT.md, DECISIONS.md, CONTEXT_INDEX.md]
---

# PLAN — Ship Reliable Zero-Key KYC MVP (Precision Edition)

> TL;DR: 4 hard blockers (Docker build, npm scripts, webhook deliverer, every-case-HITL)
> + 1 soft blocker (dashboard has hardcoded metrics) + 1 docs blocker (README demo doesn't
> reproduce). Fix with surgical precision, zero new regressions, preserve all 5 dashboard
> UX upgrades per §11 of `ARCHITECTURE_CONTEXT.md`.

## 0. Session bootstrap (read this first)

1. Adopt role `IMPLEMENTER` → `docs/roles/IMPLEMENTER.md`, instruction set `IS-001`.
2. Load `docs/ARCHITECTURE_CONTEXT.md` §3, §5, §7, §8, §11 for system map.
3. Read this plan fully — it supersedes the earlier draft (v2 "Precision Edition").
4. Do NOT delete dead code / unused deps (conservative choice) — document instead.
5. Verify at the end: `npm run typecheck && npm run test && docker build .`

### Verified findings (evidence, do not re-litigate)

| # | Finding | Evidence |
|---|---|---|
| B1 | Docker build fails — `tsconfig.json` includes `tests/**`, `drizzle.config.ts`, `vitest.config.ts`; `.dockerignore` excludes them → `TS6053` in image → CI docker gate + Fly deploy red | `tsconfig.json:34`, `.dockerignore:27-41`, `Dockerfile` build stage |
| B2 | Every real case ends `pending_hitl` — `CompositeKycDataAdapter` forces `completeness: "partial"` because `ubos.length > 0` is always false; api-lookup sets `requiresHuman` true; guardrail `!uboVerified` → HITL | `adapter.ts:14`, `opencorporates.ts:33`, `api-lookup.ts:27`, `guardrail.ts:24-27`, `edges.ts:5-7` |
| B3 | Webhook deliverer never started — `startWebhookDeliverer()` defined, never called | `src/index.ts` (only `startGraphWorker()`), `webhook-deliverer.ts:5` |
| B4 | `npm start` broken (`dist/index.js` vs real `dist/src/index.js`); `npm run launch` broken (no `scripts/` dir) | `package.json:13,23` |
| B5 | Zero-key run fails (not HITL): ComplyAdvantage always 401 (no key header); `apiLookupNode` has no try/catch; graph has no fail-open | `comply-advantage.ts:20`, `api-lookup.ts` |
| B6 | Seed inserts no `evidence` rows → demo PDF evidence chain empty; approve route doesn't validate case exists/is `pending_hitl` | `seed.ts`, `cases.ts:94-105` |
| B7 | Dashboard hardcodes metrics: High Risk = `total > 0 ? 1 : 0`; trend texts static; dead buttons (New Case, View, Export, tabs); "View Alerts mocked" toast; approve row hardcodes Low risk | `public/app.html` |
| B8 | 5 env vars missing from `.env.example`; `fly-secrets.sh` missing `API_KEY_LOOKUP_SECRET` (prod silently falls back to `JWT_SECRET`) | `env.ts`, `.env.example`, `infra/fly-secrets.sh` |

### Stub inventory (document, DO NOT delete)

`StripeBillingClient` (never wired, `recordUsage` no-op), `EmailService`/Resend (never called), S3 (unused env), `human-review.ts`, `cost-tracker.ts`, `verifyWebhookSignature`, `/usage` fake history, `/tenants/:id/usage` stub, SSE single-shot, PDF "PKCS#7 signature placeholder", `case.created` webhook never enqueued, ~8 unused npm deps.

## 1. Invariants (will NOT break)

- INV-001..INV-006 preserved unchanged.
- INV-007 preserved: `pending_hitl` exits only via `POST /cases/:id/approve` — now with atomic state validation.
- `npm run typecheck` passes with all strict flags.
- `npm run test` passes, no skipped tests, coverage ≥ current 30% threshold.
- `docker build .` succeeds (was red).
- All 5 dashboard UX upgrades still functional: toast, skeleton, ceremony, transitions, empty-states.
- Case ID generation stays `newId("case")` (random, not pinned).

---

## 2. Phase 1 — Build chain & deployment fixes

**Files:** `tsconfig.json`, new `tsconfig.build.json`, `package.json`, `Dockerfile`, `src/index.ts`, `.env.example`, `infra/fly-secrets.sh`

### A. Fix Docker build (TS6053)

1. Create `tsconfig.build.json`:
   ```json
   {
     "extends": "./tsconfig.json",
     "include": ["src/**/*.ts"],
     "exclude": ["dist", "node_modules"]
   }
   ```
2. `package.json` scripts:
   - `"build": "tsc -p tsconfig.build.json"` (was `tsc -p tsconfig.json`)
   - `"typecheck"` stays `"tsc --noEmit"` (still covers tests in CI/local)
   - `"start": "node dist/src/index.js"`
   - remove `"launch"` script (dangling)
3. `Dockerfile` build stage: change `npm run typecheck && npm run build` → `npm run build`.
4. Verify: `docker build .` OK; `ls dist/src/index.js`; `npm start` boots.

### B. Start webhook deliverer

1. `src/index.ts`: add `import { startWebhookDeliverer } from "./workers/webhook-deliverer.js";`
2. After `const worker = startGraphWorker();` → `const webhookWorker = startWebhookDeliverer();`
3. In `shutdown()`, after `await worker.close();` → `await webhookWorker.close();`

### C. Env var hygiene

1. `.env.example` — append 5 missing vars:
   ```
   LANGCHAIN_API_KEY=
   COMPLY_ADVANTAGE_API_KEY=
   COMPLY_ADVANTAGE_BASE_URL=https://api.complyadvantage.com
   S3_REGION=auto
   API_KEY_LOOKUP_SECRET=
   ```
2. `infra/fly-secrets.sh` — add `flyctl secrets set API_KEY_LOOKUP_SECRET="$(openssl rand -hex 32)"`.

---

## 3. Phase 2 — Deterministic low-risk completion (core functional fix)

**Files:** new `src/services/kyc-data/deterministic.ts`, `adapter.ts`, `opencorporates.ts`, `comply-advantage.ts`, `graph.ts`, `nodes/api-lookup.ts`, `nodes/guardrail.ts`, `edges.ts`, `routes/cases.ts`, `workers/graph-runner.ts`

### D. New `DeterministicKycDataAdapter` (T0 for kyc-data)

- Class implements `KycDataAdapter`; zero network calls; deterministic output for any input.
- Returns: `completeness: "complete"`, echo of input identity fields, `status: "active"`, `incorporationDate: null`, `address: null`, `ubos: []`, `sourceUrl: "urn:deterministic:kyc-copilot"`.
- Bundled high-risk list (matches seeded demo entities):
  ```ts
  const HIGH_RISK_ENTITIES: ReadonlyArray<{ namePattern: RegExp; jurisdiction: string; risk: "High"; pep: boolean; reason: string }> = [
    { namePattern: /volkov/i, jurisdiction: "CY", risk: "High", pep: true, reason: "Nominee-structured entity in elevated-risk jurisdiction" },
  ];
  ```
- Match: `namePattern.test(sanitize(companyName).toLowerCase())` AND jurisdiction equal → `sanctions: [{ list: "kyc-copilot-demo", matched: true, name }]`, `pep: true`.
- Edge cases: case-insensitive; jurisdiction-gated; first-match-wins; multiple rules → multiple sanction entries.

### E. Fix `CompositeKycDataAdapter` — fail-open

1. Remove the completeness override (`adapter.ts:14`) — each adapter reports truthfully.
2. Wrap `Promise.all([openCorporates.lookup, complyAdvantage.screen])` in try/catch; on throw → `new DeterministicKycDataAdapter().lookup(input)`.
3. `graph-runner.ts:23` injection unchanged (deterministic instantiated internally in catch).

### F. Fix `OpenCorporatesClient`

- `opencorporates.ts:33`: `completeness: "complete"` when registry returned a company; `ubos` stays `[]` (documented limitation, officers endpoint deferred).

### G. Fix `ComplyAdvantageClient`

- `comply-advantage.ts:20`: add `Authorization: \`Token ${env.COMPLY_ADVANTAGE_API_KEY}\`` header; import `env`. Empty key → 401 → retry → circuit breaker → deterministic fallback.

### H. Revised HITL decision architecture

#### H1. `api-lookup.ts:27`
```ts
requiresHuman: data.sanctions.some((hit) => hit.matched) || data.pep || data.completeness === "partial"
```

#### H2. `edges.ts:5-7` — skip browser when complete + low-risk
```ts
return state.apiData?.completeness === "complete" && !state.requiresHuman ? "draftDossier" : "browserFallback";
```

#### H3. `guardrail.ts:24-27` — decision table

| Condition | Result |
|---|---|
| Sanctions match OR PEP | `pending_hitl` |
| `riskScore === "High"` | `pending_hitl` |
| Medium AND `!uboVerified` | `pending_hitl` |
| `completeness === "partial"` | `pending_hitl` |
| `browserFailed === true` | `pending_hitl` |
| Low AND complete (even `!uboVerified`) | `completed` |
| Medium AND `uboVerified` AND complete | `completed` |

```ts
const sanctionsRisk = state.apiData?.sanctions.some((hit) => hit.matched) === true;
const pepRisk = state.apiData?.pep === true;
const highRisk = state.riskScore === "High" || sanctionsRisk;
const mediumUnverified = state.riskScore === "Medium" && !state.uboVerified;
const partialData = state.apiData?.completeness === "partial";
const hitl = sanctionsRisk || pepRisk || highRisk || mediumUnverified || partialData || state.browserFailed;
return { requiresHuman: hitl, status: hitl ? "pending_hitl" : "completed" };
```

### I. Fix approve route (`cases.ts:94-105`)

1. Read case first: 404 if missing; 409 if `status !== "pending_hitl"`.
2. Update WHERE adds `eq(cases.status, "pending_hitl")` (atomic — two concurrent approves can't both succeed).

---

## 4. Phase 3 — Dashboard works as architected

**Files:** `src/api/routes/dashboard.ts`, `public/app.html`

### J. Dashboard API — real risk breakdown

- Add query grouping by `riskScore` → `riskBreakdown: Object.fromEntries(rows.map(r => [r.riskScore ?? "Pending", r.count]))`.
- Response shape: `{ metrics, riskBreakdown, recentCases }`.

### K. Dashboard JS — 6 targeted fixes

1. **K1** High Risk metric: `dashData.riskBreakdown?.High ?? 0` (fallback to cases-list computation if `riskBreakdown` absent).
2. **K2** Honest trend texts (no fake "+12% since yesterday"): "awaiting analyst approval" / "cases cleared" / "elevated to HITL".
3. **K3** Wire "New Case" button → prompt for name/reg/jurisdiction → `POST /cases` → toast + reload.
4. **K4** Wire "View" row button → `GET /cases/:id` → detail toast/panel.
5. **K5** Approve row update: remove hardcoded Low-risk cell write; `btn.remove()` + `loadDashboard()`.
6. **K6** Empty-state "View All Alerts" → replace "mocked" toast with New Case flow or remove.

### L. UX upgrade verification (per §11)

Toast ✅ · Skeleton ✅ · Ceremony ✅ · `.row-updating` transition ✅ · Empty states ✅ — all must remain after edits.

---

## 5. Phase 4 — Demo end-to-end (zero-key)

**Files:** `src/db/seed.ts`, `README.md`

### M. Seed evidence rows

For the 3 demo cases insert `evidence` rows (idempotent via `onConflictDoNothing`): completed case → `API_1`; HITL case → `API_1` + `BR_1`; queued case → none.

### N. Deterministic adapter ↔ seed consistency

- "Acme Logistics BV"/NL → Low → `completed`
- "Volkov Capital Partners"/CY → High/PEP → `pending_hitl`
- "Startup XYZ"/DE → Low → would complete if processed

### O. README demo — match actual behavior

1. Case ID is random — capture from response; do not hardcode `case_demo_hitl_0002`.
2. Step 2 uses `$CASE_ID` (Volkov → `pending_hitl`).
3. Step 3 approve+PDF: use pre-seeded HITL case (curated, documented) or the created Volkov case.
4. Add zero-key mode note.

---

## 6. Phase 5 — Tests & docs

### P. Tests (surgical)

- **P1** `tests/unit/services/deterministic-kyc.test.ts`: complete output, Volkov flags, unrelated entity clean, `ubos: []`, echo fields, URN source.
- **P2** extend `tests/unit/nodes/guardrail.test.ts`: 8 decision-table cases (Low+complete+!ubo → completed; Medium+!ubo → HITL; sanctions → HITL; pep → HITL; partial → HITL; browserFailed → HITL; Medium+ubo+complete → completed; High → HITL).
- **P3** `tests/integration/api/cases-keyless.test.ts`: keyless sync low-risk → completed + report with evidence; Volkov → pending_hitl.
- **P4** extend `tests/integration/api/auth.test.ts`: approve 404 (missing), 409 (not pending_hitl).

### Q. Docs

- **Q1** new `docs/SHIPPING_STATUS.md` — ready-for-demo vs stub inventory (from §0).
- **Q2** `docs/DECISIONS.md` — ADR-013 "Deterministic KYC data fallback for zero-key operation" (mirrors ADR-010; documents HITL trigger relaxation).
- **Q3** `docs/ARCHITECTURE_CONTEXT.md` — §5 guardrail behavior, §8 INV-007 note, §15 gaps.

---

## 7. Verification checklist (28 steps, sequential)

**Build chain**
1. `npm run typecheck` green
2. `npm run build` green → `dist/src/index.js`
3. `node dist/src/index.js` boots (graph + webhook workers)
4. `docker build -t kyc-copilot:dev .` succeeds
5. `npm start` boots

**Zero-key demo**
6. `docker compose up -d db redis` healthy
7. `npm run db:migrate && npm run db:seed` idempotent
8. `LLM_TIER_PRIMARY=t0 npm run dev` on :3000
9. `POST /cases?sync=true` low-risk → `{caseId, status:"completed"}`
10. `GET /cases/$CASE_ID` → completed / Low
11. `GET /cases/$CASE_ID/report?format=json` → dossier + evidence + AMLD6
12. `GET /cases/$CASE_ID/report?format=pdf` → valid PDF
13. Volkov `?sync=true` → pending_hitl / High / requiresHuman
14. `POST /cases/$VOLKOV_ID/approve` → completed
15. Re-approve → 409 Conflict

**Dashboard**
16. `/app` — skeletons then metrics
17. High Risk metric = real count
18. Table shows seeded + created cases
19. New Case button creates + reloads
20. Approve on HITL row → ceremony + toast + completed
21. View button shows details
22. Empty-state CTA → no "mocked" toast

**Tests + webhooks**
23. `npm run test` green, coverage ≥ 30%
24. `POST /webhooks` register
25. Process case → `webhook_deliveries` → delivered

**Docs**
26. `SHIPPING_STATUS.md` exists
27. ADR-013 in DECISIONS
28. ARCHITECTURE_CONTEXT §5/§8 updated

---

## 8. Out of scope (explicitly)

Stripe/Resend/S3 wiring · real UBO extraction (officers API) · Fly failover regions (yyz/ord) · WAF automation · coverage beyond 30% · unused-dep cleanup · dead-code removal · PDF crypto signature · SSE live streaming · usage history time-series · LICENSE file.

## 9. Edge cases handled

| Edge case | Handling |
|---|---|
| compose healthcheck `/nodejs/bin/node` path | Verify against Playwright v1.61.1-jammy base image |
| `API_KEY_LOOKUP_SECRET` empty → JWT_SECRET | Documented dev-only; fly-secrets.sh fixed |
| Concurrent approves | WHERE includes `status = pending_hitl` — second is 404/409 |
| `riskScore === null` (unscored) | Dashboard → "Pending"; guardrail → not-high → completed |
| Deterministic vs real API conflict | Real adapters take priority; deterministic only on catch |
| Seed re-run | `onConflictDoNothing` — idempotent |
| Approve double-click | `btn.disabled = true` prevents double-submit |
| Zero-key LLM + zero-key KYC | Both automatic: `LLM_TIER_PRIMARY=t0` + deterministic catch fallback |

## 10. Handoff block

```markdown
- Repo: /Users/kakashi3lite/kyc-copilot @ main
- Context: docs/CONTEXT_INDEX.md → role IMPLEMENTER → IS-001 → this plan (PLAN_MVP_SHIP.md)
- Task: implement Phases 1-5 per §2-§6; run §7 verification; document stubs (§0) in SHIPPING_STATUS.md
- Files in scope: see each phase header
- Invariants at risk: INV-007 (approve gate) — enforce via §I
- Do NOT change: invariants list (§1), dead-code stubs (§0)
- Verify: npm run typecheck && npm run test && docker build .
```
