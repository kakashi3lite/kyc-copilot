---
repo: kyc-copilot
path: /Users/kakashi3lite/kyc-copilot
doc: PLAN_UBO_EXTRACTION
title: Implementation Prompt — Real UBO Extraction (OpenCorporates officers API)
status: draft-ready-for-implementation
updated: 2026-08-03
scope: Turn the documented "no UBO rows" limitation into real registry-sourced beneficial-ownership data
related: [SESSION_REPORT_2026-08-03.md §7.1, SHIPPING_STATUS.md, DECISIONS.md ADR-013, ARCHITECTURE_CONTEXT.md §5]
---

# PROMPT — Real UBO Extraction via OpenCorporates Officers API

> Hand this prompt to an IMPLEMENTER session verbatim (plus the Load block in
> §Handoff). Follow the repo's session-start convention: `docs/CONTEXT_INDEX.md`
> → role `IMPLEMENTER` → `IS-001` → load listed files → implement §Phases →
> run §Verification.

## 0. Mission

Replace the documented "UBO extraction deferred — `ubos: []` always"
limitation (`src/services/kyc-data/opencorporates.ts`) with **real
registry-sourced beneficial-ownership extraction** from the OpenCorporates
officers API — **without** breaking zero-key operation, INV-001…007, or the
"never fabricate identity data" principle (ADR-013).

The deterministic fallback (`DeterministicKycDataAdapter`) **must keep
returning `ubos: []`** — it must NEVER fabricate UBOs. Real UBOs come only
from the real provider. Zero-key demo behavior stays byte-for-byte identical.

## 1. Current state (verified 2026-08-03 — do not re-litigate)

| # | Finding | Evidence |
|---|---|---|
| U1 | `OpenCorporatesClient.lookup()` returns `ubos: []`, `completeness: "complete"` always | `src/services/kyc-data/opencorporates.ts:33` |
| U2 | `uboVerified = data.ubos.length > 0 && data.ubos.every(u => u.verified)` — only true when real UBOs exist | `src/graph/nodes/api-lookup.ts` |
| U3 | Guardrail: Low + complete → `completed` even `!uboVerified`; Medium + `!uboVerified` → HITL; `partial` → HITL | `src/graph/nodes/guardrail.ts` |
| U4 | `ApiCompanyData.ubos[].ownershipPct` is non-nullable `number` (0–100) | `src/types/index.ts` |
| U5 | Evidence hash covers the entire `ApiCompanyData` object → adding `ubos` is automatically covered; no evidence schema change | `src/graph/nodes/api-lookup.ts` (hash over `JSON.stringify(data)`) |
| U6 | No DB column stores `ubos` (only `cases.graphState` JSONB) → **no migration required** | `src/db/schema.ts` |
| U7 | Zero-key path: `DeterministicKycDataAdapter` returns `ubos: []` — keep it that way | `src/services/kyc-data/deterministic.ts` |

## 2. Design decisions (encode these, do not re-open)

- **D1 — Source endpoint:** OpenCorporates officers API:
  `GET {baseUrl}/companies/{jurisdiction}/{registration}/officers`
  Response: `{ results: { officers: [{ officer: { name, position, occupation,
  nationality, date_of_birth, current_status, percentage_of_shares } }],
  pagination: { total_entries, per_page, page } } }`. Cap at **first page
  (max 25 officers)** — no pagination chasing in v1.
- **D2 — Verified semantics:** an officer counts as `verified: true` only if
  it has a non-empty `name` and `current_status` is not explicitly a resigned/
  inactive status (e.g. `"resigned"`, `"inactive"`, `"removed"`). Officers
  without a name are dropped. Do NOT guess ownership from role.
- **D3 — Ownership honesty:** change `ApiCompanyData.ubos[].ownershipPct` from
  `number` to `number | null`. Use `percentage_of_shares` when present, else
  `null` (means "not reported by registry" — surfaced to analysts, never
  invented). Update `ApiCompanyDataSchema` (zod: `.number().min(0).max(100).nullable()`),
  `deterministic.ts` (returns `[]`, unaffected), fixtures, and any consumers.
- **D4 — Failure mode = soft-degrade, NOT every-case-HITL:** if the officers
  fetch throws / times out / trips the breaker / returns zero valid officers,
  **fall back to the company-only result** with `ubos: []` and
  `completeness: "complete"`, and log a warning. Rationale: a *documented
  limitation* must not re-introduce the old every-case-HITL behavior
  (ADR-013). Medium+`!uboVerified` already escalates the genuinely risky
  cases. Only when officers are actually returned do we populate `ubos` and
  let `uboVerified` become true.
- **D5 — Evidence:** keep a single `API_1` evidence key. Update its `summary`
  to include UBO count when present (e.g. "…with N beneficial owners reported").
  Hash already covers `ubos`.
- **D6 — Zero-key invariant:** `DeterministicKycDataAdapter` returns
  `completeness: "complete"`, `ubos: []`, `pep/sanctions` per rule. **Unchanged.**

## 3. Invariants (will NOT break)

- INV-001…INV-007 preserved.
- Zero-key demo identical: Acme → `completed`/Low, Volkov → `pending_hitl`/High.
- `npm run typecheck` (strict) green; `npm run test` green, coverage ≥ 30% lines.
- `docker build .` green.
- No fabricated UBOs anywhere (ADR-013).

## 4. Phases

### Phase A — Type honesty (`ownershipPct` nullable)

**Files:** `src/types/index.ts`, `src/graph/schemas.ts`, `tests/fixtures/mock-api-responses.ts`

1. `ApiCompanyData.ubos: ReadonlyArray<{ name: string; verified: boolean; ownershipPct: number | null }>`.
2. `ApiCompanyDataSchema.ubos` → `ownershipPct: z.number().min(0).max(100).nullable()`.
3. Fix any existing fixture/test that sets a non-null value (they all still
   compile — nullable widens, not narrows).

### Phase B — Officers fetch in `OpenCorporatesClient`

**Files:** `src/services/kyc-data/opencorporates.ts`

1. Add `private async fetchOfficers(jurisdiction, registration, companyUrl)`
   using the existing `CircuitBreaker` + `withRetry` pattern (same as `lookup`):
   - `AbortSignal.timeout(15000)`, `accept: application/json`
   - retry 3 × (250 ms→2 s), breaker(5, 30 s)
2. Parse officers; apply D2 (verified/name filter) and D3 (`ownershipPct` from
   `percentage_of_shares` else `null`).
3. In `lookup()`: call `fetchOfficers` **inside its own try/catch** (soft
   failure, D4):
   - success + ≥1 valid officer → `ubos: [...parsed]`, `completeness: "complete"`
   - failure / empty / zero valid → `ubos: []`, `completeness: "complete"`,
     `logger.warn` with the reason
4. Keep `sourceUrl` = the company URL (officers are part of the same registry
   record; add `?officers=1` note in a comment, do not change the URL).

### Phase C — Graph node + evidence

**Files:** `src/graph/nodes/api-lookup.ts`

1. `uboVerified` logic is already correct — no change (verify with a test).
2. Evidence `summary`: append `" · ${data.ubos.length} beneficial owner(s) reported by registry"` when `data.ubos.length > 0`.

### Phase D — Tests

**Files (new/extended):**
- `tests/unit/services/opencorporates-ubo.test.ts` *(new)*:
  - parses officers (name/role/ownership) into `ubos`
  - drops unnamed / resigned officers
  - `percentage_of_shares` present → `ownershipPct` set; absent → `null`
  - officers fetch throws → `ubos: []` + `completeness: "complete"` (soft-degrade, D4)
  - zero valid officers → `ubos: []`
- `tests/unit/nodes/api-lookup.test.ts` (extend): with UBO-bearing data →
  `uboVerified === true`; evidence summary contains UBO count; hash covers `ubos`.
- `tests/integration/graph/full-pipeline.test.ts` (extend):
  - officers present + Medium + verified → `completed`
  - officers fail (soft-degrade, Low) → `completed` (no every-case-HITL)
  - officers present + High risk → `pending_hitl`

### Phase E — Docs

- **Q1** `docs/DECISIONS.md` → **ADR-014 "Real UBO extraction from registry officers with soft-degrade"** (records D1–D6, ownershipPct nullable rationale, why failure soft-degrades instead of escalating).
- **Q2** `docs/ARCHITECTURE_CONTEXT.md` → §5 dependency note + §15 (resolve "Real UBO extraction … deferred" line).
- **Q3** `docs/SHIPPING_STATUS.md` → move UBO row from "stub" to "ready" (real-key path), note zero-key still `ubos: []`.

## 5. Edge cases

| Edge case | Handling |
|---|---|
| Officers API down / timeout / 5xx | Soft-degrade (D4) → `ubos: []`, `completeness: "complete"` |
| Zero officers returned for a real company | Same as above; log warning |
| Officer missing name | Dropped (D2) |
| Officer resigned/inactive | Dropped (D2) |
| No `percentage_of_shares` | `ownershipPct: null` — never invented (D3) |
| Many officers | First page only, cap 25 (D1) |
| Zero-key mode | Deterministic adapter unchanged — `ubos: []` (D6) |
| Concurrent duplicate lookups | Existing breaker + retry; no new state |

## 6. Verification checklist

1. `npm run typecheck` green
2. `npm run build` → `dist/src/index.js`
3. `npm run test` green, coverage ≥ 30% lines, no skipped tests
4. `docker build .` green
5. Zero-key regression (live): Acme `?sync=true` → `completed`/Low; Volkov → `pending_hitl`/High; approve → `completed`; re-approve → 409
6. With a real `OPEN_CORPORATES`-style key (or a local MSW stub): create NL case → `GET /cases/:id` → `graphState.apiData.ubos` populated, `uboVerified: true`
7. Officers endpoint down (stub 500): create Low case → still `completed` (soft-degrade), server log contains officers warning

## 7. Handoff block

```markdown
- Repo: /Users/kakashi3lite/kyc-copilot @ main
- Load: docs/CONTEXT_INDEX.md → role IMPLEMENTER → IS-001 →
  docs/PLAN_UBO_EXTRACTION.md → src/services/kyc-data/opencorporates.ts →
  src/types/index.ts → src/graph/schemas.ts → src/graph/nodes/api-lookup.ts
- Task: implement Phases A–E per §4; run §6 verification
- Do NOT change: deterministic.ts (zero-key `ubos: []`), guardrail table, INV-001..007
- Decision anchors: D1–D6 (§2) — do not re-open without an ADR
- Verify: npm run typecheck && npm run test && docker build .
```
