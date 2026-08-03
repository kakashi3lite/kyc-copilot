---
repo: kyc-copilot
path: /Users/kakashi3lite/kyc-copilot
doc: SESSION_REPORT_2026-08-04
title: Session Report — Phase 0 Security Hardening + Documentation Refresh
status: complete
updated: 2026-08-04
scope: 3 critical security fixes (G1, G3, G11) + comprehensive hardening plan + full documentation refresh
related:
  - PLAN_SECURITY_HARDENING.md
  - SECURITY.md
  - DECISIONS.md (ADR-018, 019, 020)
  - CONTEXT_INDEX.md
  - SHIPPING_STATUS.md
  - ARCHITECTURE_CONTEXT.md
---

# Session Report — Phase 0 Security Hardening

> **One-line summary:** Identified 12 cryptographic security gaps, fixed the 3
> most critical (PII in LLM prompts, graph cross-tenant leakage, prompt injection),
> and produced a complete 4-phase hardening roadmap. All 166 tests pass, typecheck
> green. Documentation refreshed across 6 files.

---

## 1. Executive Summary

This session was a deep security audit of the KYC Copilot codebase, triggered by
the observation that the "Privacy Shield" narrative ("we never see your PII") was
contradicted by architecture: raw decrypted PII was sent to OpenAI/Anthropic/Google
in every dossier prompt. The audit uncovered 12 security gaps across 4 severity
levels. The 3 most critical were fixed immediately; the remaining 9 are documented
with exact implementation plans.

### What Was Delivered

| # | Gap | Severity | Fix | Status |
|---|---|---|---|---|
| **G1** | Raw PII in LLM prompts | 🔴 CRITICAL | `PiiRedactor` — deterministic pseudonyms via HMAC-SHA256 | ✅ Shipped |
| **G3** | Graph cross-tenant data leakage | 🔴 CRITICAL | Tenant-scoped all graph queries; new DB migration 0004 | ✅ Shipped |
| **G11** | Prompt injection via crafted entity names | 🟡 MEDIUM | XML-tagged entity data + anti-injection preamble | ✅ Shipped |
| **G2** | Single encryption key, no hierarchy | 🔴 CRITICAL | Planned — envelope encryption (KEK + per-tenant DEK) | 📋 Phase 1 |
| **G4–G10, G12** | 7 remaining gaps | 🟠🟡 | Documented with contracts, file paths, test vectors | 📋 Phases 1–3 |

### New Files Created

| File | Purpose |
|---|---|
| `docs/PLAN_SECURITY_HARDENING.md` | 12-point hardening program — security models, contracts, test vectors, rollback plans |
| `src/services/llm/pii-redactor.ts` | Deterministic PII pseudonym engine — LLM providers never see real identity data |
| `src/db/migrations/0004_colossal_slayback.sql` | Tenant-scoped graph entity unique index |

### Files Modified

| File | Change |
|---|---|
| `src/services/kyc-data/graph-query.ts` | `getContext()` + `upsertEntity()` scoped by `tenantId`; prior cases via tenant-filtered `innerJoin` |
| `src/graph/nodes/draft-dossier.ts` | Pass `tenantId` to `getContext()` |
| `src/services/llm/adapters/prompt.ts` | PII redaction applied; XML-tagged entity data; anti-injection preamble |
| `src/db/schema.ts` | Unique index renamed: `graph_entities_reg_tenant_unique` (includes `tenant_id`) |
| `src/config/env.ts` | Added `PII_REDACTION_KEY` + `PII_REDACTION_ENABLED` |
| `SECURITY.md` | New controls, secrets, hardening checklist, related docs |
| `docs/CONTEXT_INDEX.md` | Security hardening task row + quick pointer |
| `docs/SHIPPING_STATUS.md` | Phase 0 security items in shipped matrix |
| `docs/ARCHITECTURE_CONTEXT.md` | Version bump 1.0.0→1.1.0, security section |
| `docs/DECISIONS.md` | ADR-018 (G3), ADR-019 (G1), ADR-020 (G11) |

### Verification

- `npx tsc --noEmit` → ✅ clean
- `npx vitest run` → ✅ 166 tests / 28 files / 0 failures
- Coverage thresholds met (60/40/55/60)

---

## 2. Security Model — What Changed

### Before This Session

```
Customer PII → decryptPii() → raw companyName in prompt → OpenAI API
                                 ↑
                          THIS WAS THE PROBLEM
```

### After This Session

```
Customer PII → decryptPii() → HMAC-SHA256 pseudonym → "<entity_data>ENT_a1b2c3d4</entity_data>" → OpenAI API
                                                              ↑
                                              LLM never sees real identity
```

### Attack Vectors Mitigated

| Attack Vector | Before | After |
|---|---|---|
| Compromised LLM provider reads our prompts | ✅ All PII exposed | ❌ Only pseudonyms visible |
| Malicious tenant queries another tenant's graph | ✅ Cross-tenant data leaked | ❌ Tenant-scoped queries |
| "Ignore previous instructions" in company name | ✅ Could hijack LLM | ❌ Contained in XML tags + anti-injection preamble |
| Rogue employee dumps graph_entities table | ✅ All tenants' entity data visible | ❌ Each row has tenant_id — cross-tenant correlation requires explicit join |

---

## 3. Remaining Work — Phase 1–3 Roadmap

The full 12-point plan is in `docs/PLAN_SECURITY_HARDENING.md`. Priority order:

| Phase | Gaps | When | Key Deliverable |
|---|---|---|---|
| **Phase 1 — Foundation** | G2, G12 | Week 2–3 (Aug 11–22) | Envelope encryption (KEK + per-tenant DEK); webhook key isolation via HKDF |
| **Phase 2 — Verification** | G5, G8, G4 | Week 3–4 (Aug 18–29) | Audit chain verifier; PII output scanner; cryptographic proof of deletion |
| **Phase 3 — Advanced** | G6, G10, G9 | Month 2–3 (Sep–Oct) | Shamir's Secret Sharing (3-of-2 threshold); differential privacy; forward secrecy via DEK rotation |

**Phase 1 dependency:** G2 (key hierarchy) is the foundational fix — it enables
G4 (deletion proofs), G9 (forward secrecy), G6 (threshold decryption), and G12
(webhook isolation). Every subsequent cryptographic improvement builds on
envelope encryption.

---

## 4. Documentation Refresh

All 6 documentation files updated to reflect the new security posture:

| Doc | What Changed |
|---|---|
| `SECURITY.md` | 3 new security controls, `PII_REDACTION_KEY` in secrets table + hardening checklist + incident response, §6 Related Documents |
| `CONTEXT_INDEX.md` | New row: "Security hardening / ZKP" → `PLAN_SECURITY_HARDENING.md`; new quick pointer |
| `SHIPPING_STATUS.md` | 3 shipped items: PII redaction, prompt injection defense, graph tenant isolation |
| `ARCHITECTURE_CONTEXT.md` | Version 1.0.0 → 1.1.0; `security:` block with key file references |
| `DECISIONS.md` | ADR-018 (G3 — graph tenant isolation), ADR-019 (G1 — PII redaction), ADR-020 (G11 — prompt injection defense) |
| `PLAN_SECURITY_HARDENING.md` | **NEW** — complete 12-point hardening program (this session's primary deliverable) |

---

## 5. Files Changed (Complete Index)

```
NEW:
  docs/PLAN_SECURITY_HARDENING.md
  src/services/llm/pii-redactor.ts
  src/db/migrations/0004_colossal_slayback.sql

MODIFIED:
  src/services/kyc-data/graph-query.ts       (+tenantId in all queries)
  src/graph/nodes/draft-dossier.ts            (+tenantId in getContext call)
  src/services/llm/adapters/prompt.ts         (PII redaction + XML tags + anti-injection)
  src/db/schema.ts                            (index rename: reg_tenant_unique)
  src/config/env.ts                           (PII_REDACTION_KEY, PII_REDACTION_ENABLED)
  SECURITY.md                                 (new controls, secrets, checklist, related docs)
  docs/CONTEXT_INDEX.md                       (security hardening row + pointer)
  docs/SHIPPING_STATUS.md                     (3 new shipped items)
  docs/ARCHITECTURE_CONTEXT.md                (version 1.1.0, security block)
  docs/DECISIONS.md                           (ADR-018, 019, 020)

TESTS UPDATED:
  tests/unit/services/kyc-data/graph-query.test.ts   (3-param lookups, tenant-scoped edges, innerJoin mock)
  tests/unit/nodes/draft-dossier.test.ts              (4-arg getContext call)
  tests/unit/db/schema.test.ts                        (combined migration scan for new index)
```

---

*Session closed 2026-08-04 by ZK/Privacy Guardian. Next session: Phase 1 encryption modernization (envelope encryption with KEK + per-tenant DEK).*
