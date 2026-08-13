---
repo: kyc-copilot
doc: PLAN_CRYPTO_HARDENING_EXECUTION
title: Phase 1 Execution — Cryptographic Hardening Completion (G2, G4–G10, G12)
status: approved-for-implementation
updated: 2026-08-13
scope: Complete the 9 open G-items from PLAN_SECURITY_HARDENING.md after Phases 0–5 ship; self-contained — no external API keys required
owner: ZK/Privacy Guardian
review: Principal AI Architect
related:
  - PLAN_SECURITY_HARDENING.md
  - PLAN_PRODUCTION_READINESS.md (Phase 1)
  - DECISIONS.md (ADR-024)
  - ARCHITECTURE_CONTEXT.md
  - SHIPPING_STATUS.md
target_agents: [ZK/Privacy Guardian, IMPLEMENTER, Principal AI Architect]
---

# Phase 1 Execution — Cryptographic Hardening Completion

> **Why now:** Phases 0–5 of `PLAN_PRODUCTION_READINESS.md` are shipped (2026-08-13).
> The production deploy is gated on `FLY_API_TOKEN` (operator deferred) and Phase 6 is
> gated on BD (QTSP sandbox). Every other open item (UBO real-key path, S3 evidence,
> Resend email) needs an external API key. **Phase 1 is the only remaining phase that is
> fully self-contained** — pure code + tests + local crypto, zero external credentials.
> It is therefore the correct next phase while the deploy key is pending.
>
> **Source of truth for specs:** every G-item below is specified in
> `docs/PLAN_SECURITY_HARDENING.md` §1–§12 (security model, file targets, test vectors,
> rollback). This document sequences them into shippable waves with gates — it does not
> restate the specs.

---

## §0 — Scope & Invariants

**In scope (9 items):** G2 key hierarchy · G4 proof of deletion · G5 audit-chain verify ·
G6 threshold decryption · G7 CSP hardening · G8 PII-leak scanner · G9 forward secrecy ·
G10 differential privacy · G12 webhook key isolation.

**Already shipped (do NOT touch):** G1 PII redaction · G3 graph tenant isolation ·
G11 prompt injection defense.

**Invariants (will NOT break):**

- INV-001..INV-007 preserved unchanged (`docs/ARCHITECTURE_CONTEXT.md`).
- `npm run typecheck` passes with all strict flags.
- Zero-key demo byte-identical: `LLM_TIER_PRIMARY=t0` e2e stays green.
- Coverage thresholds in `vitest.config.ts` (60/40/55/60) hold.
- `docker compose run --rm test` green at every wave boundary.
- No runtime dependency on external secrets; all new crypto keys are derived from
  existing secret material (KEK/HKDF) or local `crypto.randomBytes`.

---

## §1 — Dependency Order (from PLAN_SECURITY_HARDENING.md §14)

```
G2 (key hierarchy) ──┬─► G12 (webhook key isolation)
                     ├─► G4  (proof of deletion)
                     ├─► G9  (forward secrecy / DEK rotation)
                     └─► G6  (threshold decryption)
G5 (audit chain) ────┴─► G6
G7 (CSP) · G8 (PII scanner) · G10 (DP) — independent
```

**Rule:** never implement a G-item that depends on G2 before G2 ships (its key API
`getTenantDek()`, `wrapDek()`, `rotateTenantDek()`, `deriveWebhookKey()` is the
interface the others consume).

---

## §2 — Wave 1 · Foundation: G2 Key Hierarchy (CRITICAL)

**Objective:** replace single `ENCRYPTION_KEY` with KEK/DEK envelope encryption
(NIST SP 800-57): per-tenant DEKs wrapped with a KEK, `dek_wrapped` persisted on
`tenants`, migration window keeps the legacy path decryptable.

**Files (spec §2):**

| File | Change |
|---|---|
| `src/services/encryption/key-hierarchy.ts` | **NEW** — KEK/DEK mgmt: `getTenantDek`, `rotateTenantDek`, `rotateKek`, `deriveWebhookKey` |
| `src/services/encryption/at-rest.ts` | Route PII through `getTenantDek()` (legacy `ENCRYPTION_KEY` fallback during migration) |
| `src/db/schema.ts` + migration | Add `tenants.dek_wrapped` (text, base64) |
| `src/config/env.ts` | Add `KEK_KEY` (alias of `ENCRYPTION_KEY`), deprecation notice |
| `src/workers/dek-rotation.ts` | **NEW (Wave 3, stub here)** — rotation worker wiring point |
| `tests/unit/services/encryption/key-hierarchy.test.ts` | **NEW** — 6 vectors from spec §2 |

**Gates:** all 6 test vectors pass · migration is idempotent (`npm run db:migrate`) ·
legacy ciphertext still decrypts during the window · coverage holds.
**Rollback:** keep legacy `ENCRYPTION_KEY` path; remove only after re-encryption verified.

---

## §3 — Wave 2 · High-Risk, Small Surface: G12, G5, G7, G8

Ships independently after G2 (no cross-dependency except G12→G2).

### G12 Webhook Key Isolation (MEDIUM) — needs G2

| File | Change |
|---|---|
| `src/services/encryption/key-hierarchy.ts` | Add `deriveWebhookKey()` — HKDF(KEK, "webhook-secrets-v1") |
| `src/services/encryption/at-rest.ts` | Domain-separated key for webhook secret fields |

Gate: webhook secret decrypt uses a different key domain than PII (unit assertion).

### G5 Audit Trail Integrity Verification (HIGH)

| File | Change |
|---|---|
| `src/services/audit/logger.ts` | Add `previousHash` (hash-chain, genesis = SHA-256 of tenant creation) |
| `src/services/audit/verifier.ts` | **NEW** — `verifyAuditChain(tenantId)` walks + recomputes links |
| `src/api/routes/audit.ts` | **NEW** — `GET /audit/:tenantId/verify` |
| `src/db/schema.ts` + migration | Add `auditLogs.previousHash` |
| `tests/integration/api/audit-chain-verify.test.ts` | **NEW** — tamper one row → `{valid:false, brokenAt}` |

Gate: tampered chain detected loudly (integration test, real Postgres).

### G7 Content Security Policy Hardening (HIGH)

| File | Change |
|---|---|
| `src/api/middleware/csp.ts` | **NEW** — per-request nonce (≥128-bit) + `script-src 'self' 'nonce-…'` |
| `src/api/index.ts` | Apply CSP middleware; add `report-to /csp-violation` |
| `src/api/routes/csp-violation.ts` | **NEW** — rate-limited, unauthenticated violation sink (logs + alert) |
| `public/*.html` | `nonce=` on all inline `<script>` tags |
| `tests/integration/api/security-headers.test.ts` | **NEW** — nonce present, no `unsafe-inline`, unique per request |

Gate: no `unsafe-inline` in `script-src`; all 5 dashboard UX scripts still run (e2e).

### G8 PII Leakage Detection in LLM Output (MEDIUM)

| File | Change |
|---|---|
| `src/services/llm/pii-scanner.ts` | **NEW** — entropy (≥4.5 bits/char) + regex (email/CC/ID/passport/phone/reg-number) + known-PII match |
| `src/graph/nodes/guardrail.ts` | Run scanner on every dossier field; redact + `guardrailFinding` + audit event |
| `tests/unit/services/llm/pii-scanner.test.ts` | **NEW** — 6 vectors from spec §8 (incl. documented false-negative limitation) |

Gate: hallucinated PII in output is stripped before persist; clean output untouched.

---

## §4 — Wave 3 · Depends on G2: G4, G9

### G4 Cryptographic Proof of Deletion (CRITICAL) — needs G2

| File | Change |
|---|---|
| `src/services/encryption/deletion.ts` | **NEW** — `DeletionCertificate` (caseId, tenantId, fields, DEK fingerprint, timestamp, reason, HMAC) + verify |
| `src/services/encryption/key-hierarchy.ts` | Add `destroyTenantDek()` |
| `src/api/routes/cases.ts` | `DELETE /cases/:id?mode=hard` (GDPR erasure; tombstone `DELETED:<cert-hash>`) |
| `tests/unit/services/encryption/deletion.test.ts` | **NEW** — 4 vectors from spec §4 |
| `tests/e2e/gdpr-erasure-proof.test.ts` | **NEW** — erase → cert row + tombstone; decrypt throws |

Gate: after hard delete, `decryptPii` throws "Tombstone"; cert verifies; cross-tenant DEK untouched.

### G9 Forward Secrecy via DEK Rotation (MEDIUM) — needs G2

| File | Change |
|---|---|
| `src/services/encryption/key-hierarchy.ts` | `rotateTenantDek()` with full re-encrypt + old-DEK destruction |
| `src/workers/dek-rotation.ts` | **NEW** — BullMQ rotation worker (90-day cadence, per tenant) |
| `tests/unit/services/encryption/key-hierarchy.test.ts` | Add rotation + forward-secrecy vectors (old ciphertext fails after rotation) |

Gate: post-rotation, old ciphertext undecryptable; audit event records old/new DEK fingerprints.

---

## §5 — Wave 4 · Design/Policy-Gated: G6, G10

> Both need a written decision before implementation (see §7 blockers). Do NOT start
> Wave 4 until the ADR/policy sign-off exists — the rest of Phase 1 ships without it.

### G6 Threshold Decryption for Deanonymization (HIGH) — needs G2, G5

| File | Change |
|---|---|
| `src/services/crypto/threshold.ts` | **NEW** — Shamir SSS over GF(2⁸), 2-of-3 (KYC Copilot, institution, regulator trustee) |
| `src/services/crypto/deanonymize.ts` | **NEW** — legal-authority-gated workflow, audit-logged, deanonymized flag |
| `src/api/routes/deanonymize.ts` | **NEW** — `POST /cases/:id/deanonymize` |
| `src/db/schema.ts` + migration | `cases.irk_share`, `deanonymization_requests` |
| `tests/unit/services/crypto/threshold.test.ts` | **NEW** — 6 vectors from spec §6 |

Gate: 1-of-3 cannot reconstruct; every attempt audit-logged.
**Blocked on:** key-custody policy (who holds the 3rd share) — ADR required.

### G10 Differential Privacy for Graph Queries (MEDIUM)

| File | Change |
|---|---|
| `src/services/crypto/differential-privacy.ts` | **NEW** — Laplace noise + per-tenant ε/δ budget tracker |
| `src/services/kyc-data/graph-query.ts` | Apply DP to aggregate queries; budget-exhausted → coarser/refuse |
| `tests/unit/services/crypto/differential-privacy.test.ts` | **NEW** |

Gate: repeated aggregate queries converge to noisy estimate; budget exhaustion enforced.
**Blocked on:** ε budget policy (privacy-vs-utility) — ADR required.

---

## §6 — Test Plan (new files)

| Item | Test path | Proves |
|---|---|---|
| G2/G9 | `tests/unit/services/encryption/key-hierarchy.test.ts` | envelope, rotation, forward secrecy, cross-tenant |
| G4 | `tests/unit/services/encryption/deletion.test.ts` + `tests/e2e/gdpr-erasure-proof.test.ts` | cert + tombstone + irrecoverability |
| G5 | `tests/integration/api/audit-chain-verify.test.ts` | tamper detection on real Postgres |
| G7 | `tests/integration/api/security-headers.test.ts` | nonce CSP, no `unsafe-inline` |
| G8 | `tests/unit/services/llm/pii-scanner.test.ts` | hallucinated-PII strip |
| G6 | `tests/unit/services/crypto/threshold.test.ts` | SSS 2-of-3 |
| G10 | `tests/unit/services/crypto/differential-privacy.test.ts` | Laplace + budget |

**Every wave ends with:** `find . -name '._*' -type f -delete` →
`npm run typecheck` → `npm run test:unit` → `npm run test:eval` →
`docker compose run --rm test` (real Postgres + Redis) → coverage thresholds hold.

---

## §7 — Hard Gates & Exit Criteria

| Gate | Criteria | Enforced by |
|---|---|---|
| Coverage | ≥ 60/40/55/60 | `vitest.config.ts` |
| Zero-key demo | `LLM_TIER_PRIMARY=t0` full e2e green | compose `test` service |
| Audit integrity | tampered chain detected | G5 integration test |
| Erasure | deletion certificate emitted, decrypt throws | e2e |
| CSP | no `unsafe-inline` in `script-src` | headers test |
| Phase 1 exit | 7 G-items shipped (G2,G12,G5,G7,G8,G4,G9) + Wave-4 items blocked only on ADRs | milestone review |

**Blockers (tracked, not code):** G6 key-custody ADR · G10 ε-budget ADR. Both can be
drafted as draft ADRs in `docs/DECISIONS.md` and flipped to Accepted at sign-off.

**Rollback:** each G-item ships as its own commit; per-item rollback table in
`PLAN_SECURITY_HARDENING.md` §16 (e.g. `PII_REDACTION_ENABLED=false`,
keep-old-`ENCRYPTION_KEY`-path, revert-to-static-CSP). G2 is reversible only before
tenant data re-encryption — take a Postgres backup immediately before that step
(`scripts/dr/restore-drill.sh` readiness already proven).

---

## §8 — Sequencing rationale (why Phase 1, not the alternatives)

| Option | Why not now |
|---|---|
| Production deploy | Gated on `FLY_API_TOKEN` (operator deferred); needs `infra/fly-secrets.sh` once |
| UBO real-key path | Needs OpenCorporates API key |
| S3 evidence offload | Needs live R2/cloud credentials (C5) |
| Resend email | Needs Resend API key |
| Phase 6 (ZKP/eIDAS) | Needs QTSP sandbox + design partner (BD) |
| **Phase 1 crypto hardening** | **✅ self-contained — zero external credentials** |
