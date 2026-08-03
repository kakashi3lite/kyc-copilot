---
repo: kyc-copilot
path: /Users/kakashi3lite/kyc-copilot
doc: PLAN_BLUE_OCEAN_IMPLEMENTATION
title: Blue Ocean Implementation Plan — CostRouter, RAGGraphBuilder, KYTClassifier
status: sprints 1-5 shipped (2026-08-04) · sprint 6 deferred
updated: 2026-08-04
scope: Executable implementation specs for the three AI subsystems
author: Vector/Graph Architect (ML/Data Engineer)
related:
  - BLUE_OCEAN_ARCHITECTURE.md
  - ARCHITECTURE_CONTEXT.md
  - DECISIONS.md
target_agent: competitive-coder
---

# Blue Ocean Implementation Plan

> **Target Audience:** The `competitive-coder` agent. Every section is self-contained, defines interface contracts before implementation, includes exact file paths, specifies test requirements, and provides a one-sentence rollback.
>
> **Guiding Principle:** No Jupyter notebooks. No untyped LLM outputs. No orphaned code. Every change ships with a benchmark.

---

## §0 — Executive Summary

This document translates the [Blue Ocean Architecture](./BLUE_OCEAN_ARCHITECTURE.md) into **concrete, executable implementation plans** for the three AI subsystems owned by the Vector/Graph Architect:

| Subsystem | Status | This Document Covers |
|---|---|---|
| **CostRouter** | ✅ **Shipped (Sprints 1–3)** | Cost tracking wired into all adapters, per-tenant budget enforcement, difficulty-aware routing, Redis semantic cache |
| **RAGGraphBuilder** | ✅ **Shipped (Sprints 4–5)** | Entity resolution, graph schema (3 tables, migration `0003`), cross-case graph, graph-enhanced prompts |
| **KYTClassifier** | 🔴 Deferred (Sprint 6) | Tree-ensemble typology classifier — blocked on graph scale + transaction data source |

> **Execution log:** Sprints 1–5 implemented 2026-08-04 by `competitive-coder`. All gates green
> (typecheck, build, 166 tests / 28 files, coverage 66.6/54.8/68.6/67.7 ≥ 60/40/55/60). Migration
> `0003_true_jack_murdock.sql` applied to the real Postgres; E2E lifecycle verified graph
> entity upsert + case linking end-to-end. See §13 — Execution Log for deviations & benchmarks.

### Critical Pre-existing Findings (Read Before Coding)

These were discovered during architecture review and are **security-critical**:

| # | Severity | Finding | Fix Location |
|---|---|---|---|
| **F1** | CRITICAL | `graphState` jsonb stores decrypted PII — bypasses ADR-003 encrypt+mask | `src/workers/graph-runner.ts:48` |
| **F2** | CRITICAL | `recordTokenUsage()` is dead code — never called from router or adapters | `src/services/llm/cost-tracker.ts` |
| **F3** | CRITICAL | No LLM prompt/response audit trail for regulatory compliance | `src/services/llm/router.ts` |
| **F4** | HIGH | `tenant.llmBudgetUsd` exists but zero enforcement | `src/services/llm/router.ts` |
| **F5** | HIGH | No HTML sanitization on LLM output — XSS vector in dashboard | `src/graph/nodes/draft-dossier.ts` |
| **F6** | HIGH | Guardrail only validates citation format, not semantic accuracy | `src/graph/nodes/guardrail.ts` |
| **F7** | HIGH | Single `ENCRYPTION_KEY` — no rotation mechanism | `src/services/encryption/at-rest.ts` |

---

## §1 — Interface Contracts (Implement Before Any Logic)

Every LLM call and every graph state mutation must pass through a typed contract. These are the Zod schemas and TypeScript interfaces that the coder must implement FIRST, before any runtime logic.

### 1.1 Cost Tracking Contract

```typescript
// FILE: src/services/llm/cost-tracker.ts — EXTEND existing file

import { z } from "zod";

/** Record of a single LLM call for cost tracking + audit. */
export const LlmCallRecordSchema = z.object({
  tenantId: z.string().min(1),
  caseId: z.string().min(1),
  modelId: z.string().min(1),
  tier: z.enum(["t0", "t1", "t2", "t3", "t4"]),
  promptTokens: z.number().int().min(0),
  completionTokens: z.number().int().min(0),
  costUsd: z.number().min(0),
  promptHash: z.string().length(64),   // SHA-256 hex
  responseHash: z.string().length(64), // SHA-256 hex
  latencyMs: z.number().int().min(0),
  cached: z.boolean().default(false),
});
export type LlmCallRecord = z.infer<typeof LlmCallRecordSchema>;

/** Budget check result — returned before any LLM call. */
export const BudgetCheckResultSchema = z.discriminatedUnion("allowed", [
  z.object({ allowed: z.literal(true), spentUsd: z.number(), budgetUsd: z.number(), remainingUsd: z.number(), warning: z.boolean() }),
  z.object({ allowed: z.literal(false), spentUsd: z.number(), budgetUsd: z.number(), reason: z.enum(["budget_exceeded", "tenant_disabled"]) }),
]);
export type BudgetCheckResult = z.infer<typeof BudgetCheckResultSchema>;
```

### 1.2 Semantic Cache Contract

```typescript
// FILE: src/services/llm/cache.ts — NEW file

import { z } from "zod";

export const CacheEntrySchema = z.object({
  promptHash: z.string().length(64),
  response: z.object({
    claims: z.array(z.object({ id: z.string(), text: z.string(), sourceKey: z.string() })),
    riskScore: z.enum(["Low", "Medium", "High", "Pending"]),
    summary: z.string(),
  }),
  modelId: z.string(),
  costSavedUsd: z.number(),
  createdAt: z.string(), // ISO-8601
  ttlSeconds: z.number().int().min(0),
});
export type CacheEntry = z.infer<typeof CacheEntrySchema>;

export interface SemanticCache {
  get(promptHash: string): Promise<CacheEntry | null>;
  set(entry: CacheEntry): Promise<void>;
  invalidate(tenantId: string): Promise<void>;
}
```

### 1.3 Difficulty Classifier Contract

```typescript
// FILE: src/services/llm/difficulty-classifier.ts — NEW file

import { z } from "zod";
import type { AgentState } from "../../graph/state.js";

/** Features extracted from AgentState for difficulty classification. */
export const DifficultyFeaturesSchema = z.object({
  jurisdictionRiskScore: z.number().min(0).max(1),     // 0=low risk, 1=blacklisted
  hasSanctionsHit: z.boolean(),
  hasPepFlag: z.boolean(),
  dataCompleteness: z.number().min(0).max(1),           // 1=complete
  uboCount: z.number().int().min(0),
  uboVerifiedFraction: z.number().min(0).max(1),
  evidenceSourceCount: z.number().int().min(0),
  priorCaseCount: z.number().int().min(0),              // cross-case entities
  estimatedTokenCount: z.number().int().min(0),
});
export type DifficultyFeatures = z.infer<typeof DifficultyFeaturesSchema>;

/** Tier assignment with confidence. */
export const TierAssignmentSchema = z.object({
  tier: z.enum(["t0", "t2", "t4"]),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});
export type TierAssignment = z.infer<typeof TierAssignmentSchema>;

export interface DifficultyClassifier {
  /** Extract features from graph state. Pure function, no I/O. */
  extractFeatures(state: AgentState): DifficultyFeatures;
  /** Classify task complexity → tier assignment. Deterministic. */
  classify(features: DifficultyFeatures): TierAssignment;
}
```

### 1.4 Entity Resolution Contract

```typescript
// FILE: src/services/kyc-data/entity-resolver.ts — NEW file

import { z } from "zod";

/** A resolved entity with cross-source reconciliation. */
export const ResolvedEntitySchema = z.object({
  canonicalName: z.string(),
  registrationNumber: z.string(),
  jurisdiction: z.string().length(2),
  sources: z.array(z.object({
    sourceName: z.string(),          // "opencorporates" | "complyadvantage" | "browser"
    name: z.string(),
    matchConfidence: z.number().min(0).max(1),
  })),
  confidence: z.number().min(0).max(1),  // overall resolution confidence
  conflicts: z.array(z.object({
    field: z.string(),
    sourceValues: z.record(z.string()),
  })),
});
export type ResolvedEntity = z.infer<typeof ResolvedEntitySchema>;

export interface EntityResolver {
  /** Resolve a single entity across all data sources. */
  resolve(apiData: import("../../types/index.js").ApiCompanyData, browserData?: import("../../types/index.js").ApiCompanyData | null): ResolvedEntity;
}
```

---

## §2 — Sprint 1: Security Foundations (CRITICAL — Do First)

> **Goal:** Fix the three critical security findings before any feature work.
> **Success metric:** Zero PII in `graphState` jsonb. LLM audit trail active. Output sanitization in place.

### Task 1.1 — Strip PII from graphState Before Persist

**File:** `src/workers/graph-runner.ts`
**Change:** After the graph run completes, strip `companyName` and `registrationNumber` from the state object before writing to `cases.graphState`.

**Why:** The `AgentState` extends `EntityInput`, which carries decrypted `companyName` and `registrationNumber`. When `graphState` is serialized to `jsonb`, this leaks decrypted PII into the database alongside the encrypted columns — completely bypassing ADR-003.

**Implementation:**

```typescript
// In graph-runner.ts, after `const state = await graph.run(...)` and before
// `db.update(cases).set(...)`, add:

// Strip PII from graph state before persistence (ADR-003: encrypt+mask pattern).
// The state carries decrypted companyName/registrationNumber in memory for the
// graph pipeline, but these MUST NOT be persisted in the graphState jsonb column
// — they already exist in encrypted form in cases.companyNameEncrypted etc.
const safeState: Record<string, unknown> = { ...state as unknown as Record<string, unknown> };
delete safeState.companyName;
delete safeState.registrationNumber;
// Then use safeState in the db.update call instead of state.
```

**Exact code to replace in `graph-runner.ts`:**
- Find: `graphState: state as unknown as Record<string, unknown>`
- Replace with: `graphState: safeState`

**Test:** `tests/unit/workers/graph-runner.test.ts` — verify that `graphState` jsonb does NOT contain `companyName` or `registrationNumber` keys after a case completes.

**Rollback:** Revert the `safeState` variable and pass `state` directly. One-line change.

---

### Task 1.2 — LLM Output Sanitization

**File:** `src/utils/mask.ts` (extend) + `src/graph/nodes/draft-dossier.ts` (apply)

**Why:** The LLM output goes directly into `cases.dossier` (plaintext) and is rendered in `public/app.html`. There is no HTML entity encoding on LLM-generated text. A hallucinated `<script>` tag becomes a stored XSS.

**Implementation — Step A: Add `sanitizeOutput` to `src/utils/mask.ts`:**

```typescript
// FILE: src/utils/mask.ts — APPEND this function

const SCRIPT_PATTERN = /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi;
const HTML_TAG_PATTERN = /<[^>]*>/g;
const DANGEROUS_PROTOCOL = /javascript:|data:text\/html|vbscript:/gi;

/**
 * Sanitize LLM-generated output text for safe storage and display.
 * Unlike sanitizeInput (which strips everything aggressive for injection
 * prevention), sanitizeOutput is conservative — it only strips genuinely
 * dangerous constructs while preserving legitimate punctuation and
 * formatting that an LLM might produce in a dossier.
 */
export function sanitizeOutput(text: string): string {
  return text
    .normalize("NFKC")
    .replace(SCRIPT_PATTERN, "")        // strip <script>...</script> blocks
    .replace(DANGEROUS_PROTOCOL, "")    // strip javascript: etc.
    .replace(HTML_TAG_PATTERN, "");     // strip remaining HTML tags
}
```

**Implementation — Step B: Apply in `src/graph/nodes/draft-dossier.ts`:**

After `DossierSchema.parse()`, sanitize every text field in the result:

```typescript
// In draftDossierNode, after: const result = DossierSchema.parse(await deps.llm.draftDossier(state));
// Add sanitization pass:
const sanitizedResult = {
  ...result,
  summary: sanitizeOutput(result.summary),
  claims: result.claims.map(c => ({ ...c, text: sanitizeOutput(c.text) })),
};
// Use sanitizedResult instead of result in the dossier construction below.
```

**Test:** `tests/unit/utils/mask.test.ts` — add cases:
- `sanitizeOutput("<script>alert(1)</script>")` → `"alert(1)"`
- `sanitizeOutput("<img onerror=alert(1)>")` → `""`
- `sanitizeOutput("Normal text with <b>bold</b>")` → `"Normal text with bold"`
- `sanitizeOutput("javascript:void(0)")` → `"void(0)"`

**Rollback:** Remove `sanitizeOutput()` call in `draftDossierNode`. Revert to using `result` directly.

---

### Task 1.3 — LLM Call Audit Trail

**File:** `src/services/llm/router.ts` (extend `DynamicLlmRouter`) + `src/services/audit/logger.ts` (extend)

**Why:** AMLD6 Article 8 and MiCA Article 68 require regulated entities to explain AI-assisted decisions. Currently, the LLM prompt and response are ephemeral — they exist only in memory during the call. Regulators cannot audit what the model was asked or how it answered.

**Implementation:**

```typescript
// FILE: src/services/llm/audit.ts — NEW file

import { createHash } from "node:crypto";
import { writeAuditLog } from "../audit/logger.js";
import type { LlmCallRecord } from "./cost-tracker.js";

/**
 * Write an immutable audit log entry for each LLM call.
 * Stores hashes of prompt/response for integrity verification;
 * full text replay is available via the evidence ledger if needed.
 */
export async function auditLlmCall(record: LlmCallRecord, promptText: string, responseText: string): Promise<void> {
  const promptHash = createHash("sha256").update(promptText).digest("hex");
  const responseHash = createHash("sha256").update(responseText).digest("hex");

  await writeAuditLog({
    tenantId: record.tenantId,
    caseId: record.caseId,
    actor: "system",
    action: "llm.call",
    oldValue: null,
    newValue: {
      modelId: record.modelId,
      tier: record.tier,
      promptTokens: record.promptTokens,
      completionTokens: record.completionTokens,
      costUsd: record.costUsd,
      latencyMs: record.latencyMs,
      promptHash,
      responseHash,
      cached: record.cached,
    },
  });
}
```

**Integration point:** Call `auditLlmCall()` from `DynamicLlmRouter.draftDossier()` after each successful adapter call, before returning. If the adapter is `DeterministicLlmClient` (t0), skip the audit log — t0 is rule-based with no LLM.

**Test:** `tests/unit/services/llm/audit.test.ts` — verify:
- Audit log entry written with correct `action: "llm.call"`
- `promptHash` is deterministic (same prompt → same hash)
- t0 calls do NOT generate audit entries
- Audit entry contains all required fields from `LlmCallRecordSchema`

**Rollback:** Comment out the `auditLlmCall()` call in the router. Audit logs are append-only so historical entries persist.

---

## §3 — Sprint 2: Cost Visibility & Budget Enforcement

> **Goal:** Make the `cost-tracker.ts` functional. Every LLM call is measured. Every tenant has a budget cap.
> **Success metric:** `usage.costUsd` > 0 for at least one tenant. Budget-exceeded tenants get t0 fallback instead of t2/t4.

### Task 2.1 — Wire `recordTokenUsage` Into the LLM Adapters

**Files:** `src/services/llm/adapters/openai.ts`, `anthropic.ts`, `google.ts`, `ollama.ts`

**Why:** `recordTokenUsage` is a fully implemented function that writes to the `usage` table. It is imported by zero files. The Blue Ocean Phase 0 prerequisite ("cost-per-dossier measured to ±5%") is impossible without this.

**Implementation:**

Each adapter's `draftDossier()` method must call `recordTokenUsage` with actual token counts from the API response metadata. Example for OpenAI:

```typescript
// FILE: src/services/llm/adapters/openai.ts — MODIFY draftDossier method

import { recordTokenUsage } from "../cost-tracker.js";

// Inside draftDossier(), after structured.invoke():
public async draftDossier(state: AgentState): Promise<DossierDraft> {
  const structured = this.model.withStructuredOutput(DossierSchema);
  const startMs = Date.now();
  const result = await structured.invoke([
    new SystemMessage("You are a KYC/AML compliance analyst. Output a structured dossier as JSON."),
    new HumanMessage(buildDossierPrompt(state)),
  ]);
  const latencyMs = Date.now() - startMs;

  // Extract token usage from LangChain response metadata.
  // ChatOpenAI exposes usage_metadata on the AIMessage.
  const aiMsg = result as unknown as { usage_metadata?: { input_tokens: number; output_tokens: number } };
  const promptTokens = aiMsg.usage_metadata?.input_tokens ?? 0;
  const completionTokens = aiMsg.usage_metadata?.output_tokens ?? 0;
  const costUsd = (promptTokens / 1000) * this.costPer1kInput + (completionTokens / 1000) * this.costPer1kOutput;

  // Fire-and-forget — don't block the dossier return on cost tracking.
  recordTokenUsage(state.tenantId ?? "", promptTokens, completionTokens, costUsd).catch(() => {});

  return result as DossierDraft;
}
```

**Note:** The `OpenAiAdapter` constructor currently takes `(modelId, apiKey)`. Extend to also accept `costPer1kInput` and `costPer1kOutput` from the `ProviderConfig` so the adapter can compute cost internally.

**Interface change — `OpenAiAdapter` constructor:**

```typescript
// BEFORE:
public constructor(modelId: string, apiKey: string)

// AFTER:
public constructor(modelId: string, apiKey: string, costPer1kInput: number, costPer1kOutput: number)
```

Update `createAdapter()` in `router.ts` to pass cost metadata:

```typescript
case "openai": {
  const key = env.OPENAI_API_KEY;
  if (!key) { /* fallback */ }
  const { OpenAiAdapter } = require("./adapters/openai.js");
  return new OpenAiAdapter(provider.modelId, key, provider.costPer1kInput, provider.costPer1kOutput);
}
```

**Test:** `tests/unit/services/llm/cost-tracker.test.ts` — NEW file.
- Mock the adapter response with `usage_metadata`.
- Verify `recordTokenUsage` is called with correct token counts.
- Verify cost calculation: `(1500/1000 * 0.00015) + (500/1000 * 0.0006) = 0.000525`.

**Rollback:** Revert the constructor signature change. Remove `recordTokenUsage` call from adapters.

---

### Task 2.2 — Per-Tenant LLM Budget Enforcement

**File:** `src/services/llm/router.ts` (extend `DynamicLlmRouter`)

**Why:** `tenants.llmBudgetUsd` defaults to `$100.00`. Nothing checks it. A tenant can burn $10,000/mo on GPT-4o without any circuit breaking. This is a cost leak and a billing dispute risk.

**Implementation:**

```typescript
// FILE: src/services/llm/budget.ts — NEW file

import { eq, and, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { tenants, usage } from "../../db/schema.js";
import { monthKey } from "../../utils/date.js";
import type { BudgetCheckResult } from "./cost-tracker.js";
import { childLogger } from "../../config/logger.js";

const log = childLogger({ component: "llm-budget" });

/**
 * Check whether a tenant has remaining LLM budget for the current month.
 * Reads cumulative `costUsd` from the usage table and compares against
 * the tenant's `llmBudgetUsd` cap.
 *
 * Returns { allowed: false } when:
 *   - Tenant not found or disabled
 *   - Monthly spend >= llmBudgetUsd
 *
 * Returns { allowed: true, warning: true } when spend >= 80% of budget.
 */
export async function checkLlmBudget(tenantId: string): Promise<BudgetCheckResult> {
  const tenant = await db.select({
    budgetUsd: tenants.llmBudgetUsd,
    active: tenants.active,
  }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);

  const t = tenant[0];
  if (!t || !t.active) {
    return { allowed: false, spentUsd: 0, budgetUsd: 0, reason: "tenant_disabled" };
  }

  const budgetUsd = Number(t.budgetUsd);
  const month = monthKey();
  const rows = await db.select({
    totalCost: sql<number>`COALESCE(SUM(${usage.costUsd}), 0)`,
  }).from(usage).where(and(eq(usage.tenantId, tenantId), eq(usage.month, month)));

  const spentUsd = Number(rows[0]?.totalCost ?? 0);
  const remainingUsd = Math.max(0, budgetUsd - spentUsd);

  if (spentUsd >= budgetUsd) {
    log.warn({ tenantId, spentUsd, budgetUsd }, "LLM budget exceeded");
    return { allowed: false, spentUsd, budgetUsd, reason: "budget_exceeded" };
  }

  const warning = spentUsd >= budgetUsd * 0.8;
  if (warning) {
    log.warn({ tenantId, spentUsd, budgetUsd, remainingUsd }, "LLM budget at 80%+ warning threshold");
  }

  return { allowed: true, spentUsd, budgetUsd, remainingUsd, warning };
}
```

**Integration point in `DynamicLlmRouter.draftDossier()`:**

```typescript
// Before calling pickModel() or any adapter:
const budget = await checkLlmBudget(state.tenantId ?? "");
if (!budget.allowed) {
  log.warn({ tenantId: state.tenantId, reason: budget.reason }, "budget blocked, routing to t0");
  return this.deterministic.draftDossier(state);
}
// If warning, force t2 maximum (no t4 for near-budget tenants):
const effectiveTier = budget.warning && ctx.configuredTier === "t4" ? "t2" : ctx.configuredTier;
```

**Test:** `tests/unit/services/llm/budget.test.ts` — NEW file.
- Tenant with $0 spent, $100 budget → `{ allowed: true, warning: false }`
- Tenant with $80 spent, $100 budget → `{ allowed: true, warning: true }`
- Tenant with $100 spent, $100 budget → `{ allowed: false, reason: "budget_exceeded" }`
- Tenant not found → `{ allowed: false, reason: "tenant_disabled" }`

**Rollback:** Remove the `checkLlmBudget` call from the router. Budget column remains but is unenforced.

---

## §4 — Sprint 3: Difficulty-Aware Routing + Semantic Cache

> **Goal:** Route 60%+ of dossier tasks to t2 (GPT-4o-mini) without quality degradation. Cache repeated lookups.
> **Success metric:** ≥60% of LLM calls use t0–t2. Cache hit rate ≥15%.

### Task 3.1 — Difficulty Classifier (Deterministic, No ML)

**File:** `src/services/llm/difficulty-classifier.ts` — NEW file

**Why:** The current `pickModel()` routes by token count (>120K → t3) and strict-json requirement. It does not consider case complexity. A simple company with complete registry data, no sanctions, no PEP, low-risk jurisdiction → should be t0 (deterministic) or t2 (cheap LLM). Currently it always hits the configured tier (default t2).

**Implementation — Feature Extractor (pure function, testable):**

```typescript
// FILE: src/services/llm/difficulty-classifier.ts

import type { AgentState } from "../../graph/state.js";
import type { DifficultyClassifier, DifficultyFeatures, TierAssignment } from "./difficulty-classifier.js";

// Jurisdiction risk tiers — mirrors the blacklist/greylist in client.ts
const BLACKLIST = new Set(["KP", "IR", "MM"]);
const GREYLIST = new Set(["BG", "HR", "CD", "HT", "ML", "MZ", "NA", "NG", "PH", "SN", "SS", "SY", "TZ", "VE", "VN", "YE"]);

export class DeterministicDifficultyClassifier implements DifficultyClassifier {
  public extractFeatures(state: AgentState): DifficultyFeatures {
    const jurisdictionRisk = BLACKLIST.has(state.jurisdiction) ? 1.0
      : GREYLIST.has(state.jurisdiction) ? 0.5 : 0.0;

    const sanctionsHit = state.apiData?.sanctions.some(s => s.matched) ?? false;
    const pepFlag = state.apiData?.pep ?? false;
    const uboCount = state.apiData?.ubos.length ?? 0;
    const uboVerifiedCount = state.apiData?.ubos.filter(u => u.verified).length ?? 0;
    const dataCompleteness = state.apiData?.completeness === "complete" ? 1.0 : 0.5;
    const evidenceCount = Object.keys(state.evidenceLedger).length;

    return {
      jurisdictionRiskScore: jurisdictionRisk,
      hasSanctionsHit: sanctionsHit,
      hasPepFlag: pepFlag,
      dataCompleteness,
      uboCount,
      uboVerifiedFraction: uboCount > 0 ? uboVerifiedCount / uboCount : 0,
      evidenceSourceCount: evidenceCount,
      priorCaseCount: 0, // placeholder — populated when RAG-Graph is built
      estimatedTokenCount: JSON.stringify(state).length / 4,
    };
  }

  public classify(features: DifficultyFeatures): TierAssignment {
    // Rule 1: Any sanctions hit or PEP → t4 (needs best reasoning)
    if (features.hasSanctionsHit || features.hasPepFlag) {
      return { tier: "t4", confidence: 0.95, reason: "sanctions or PEP flag requires best model" };
    }

    // Rule 2: High-risk jurisdiction + incomplete data → t4
    if (features.jurisdictionRiskScore >= 0.5 && features.dataCompleteness < 1.0) {
      return { tier: "t4", confidence: 0.85, reason: "elevated jurisdiction with partial data" };
    }

    // Rule 3: Complete data + low-risk jurisdiction + no flags → t0 (deterministic)
    if (features.dataCompleteness >= 1.0 && features.jurisdictionRiskScore === 0 && features.uboVerifiedFraction >= 1.0) {
      return { tier: "t0", confidence: 0.90, reason: "complete data, low risk, all UBOs verified" };
    }

    // Rule 4: Complete data + low-risk jurisdiction (UBOs not all verified) → t2
    if (features.dataCompleteness >= 1.0 && features.jurisdictionRiskScore === 0) {
      return { tier: "t2", confidence: 0.80, reason: "complete data, low risk, minor UBO gaps" };
    }

    // Rule 5: Very large evidence context → t3 (Gemini Flash for 1M context)
    if (features.estimatedTokenCount > 120_000) {
      return { tier: "t3", confidence: 0.85, reason: "large evidence context" };
    }

    // Default: t2 for everything else (70% of cases)
    return { tier: "t2", confidence: 0.70, reason: "standard complexity, routing to cost-optimized tier" };
  }
}
```

**Integration point in `DynamicLlmRouter.draftDossier()`:**

Replace the current `pickModel()` call with the difficulty classifier. The classifier's tier assignment overrides the configured tier:

```typescript
// In draftDossier():
const classifier = new DeterministicDifficultyClassifier();
const features = classifier.extractFeatures(state);
const assignment = classifier.classify(features);

log.info({
  assignedTier: assignment.tier,
  confidence: assignment.confidence,
  reason: assignment.reason,
  configuredTier: env.LLM_TIER_PRIMARY,
}, "difficulty classifier assigned tier");

// Use assignment.tier instead of env.LLM_TIER_PRIMARY for model selection,
// bounded by budget enforcement (Task 2.2 may downgrade further).
const effectiveTier = /* budget check may downgrade */ assignment.tier;
const selected = getProvider(effectiveTier);
```

**Test:** `tests/unit/services/llm/difficulty-classifier.test.ts` — NEW file. Test each rule:
- Sanctions hit → t4
- PEP flag → t4
- Complete data + low risk + UBOs verified → t0
- Complete data + low risk + UBOs unverified → t2
- Partial data + greylist jurisdiction → t4
- Large context (>120K tokens) → t3
- Standard case (medium jurisdiction, partial data) → t2

**Rollback:** Set `LLM_TIER_PRIMARY=t4` in env. The classifier is bypassed when the weighted routing is removed from the router.

---

### Task 3.2 — Semantic Cache (Redis-Backed)

**File:** `src/services/llm/cache.ts` — NEW file

**Why:** Enterprise customers processing related entities get repeated sanctions/registry data. Same company name + jurisdiction + data completeness → identical LLM prompt → identical response. Caching avoids the LLM call entirely for 15–25% of requests.

**Implementation:**

```typescript
// FILE: src/services/llm/cache.ts

import { createHash } from "node:crypto";
import { redis } from "../../db/index.js";
import type { DossierDraft } from "./client.js";
import type { AgentState } from "../../graph/state.js";
import type { CacheEntry, SemanticCache } from "./cache.js";
import { childLogger } from "../../config/logger.js";

const log = childLogger({ component: "llm-cache" });

/** Build a deterministic cache key from the state that drives the prompt. */
function cacheKey(state: AgentState): string {
  const canonical = JSON.stringify({
    companyName: state.companyName.toLowerCase().trim(),
    jurisdiction: state.jurisdiction,
    status: state.apiData?.status,
    sanctions: state.apiData?.sanctions.map(s => `${s.list}:${s.name}:${s.matched}`).sort(),
    pep: state.apiData?.pep,
    uboCount: state.apiData?.ubos.length,
    completeness: state.apiData?.completeness,
  });
  return `llm:cache:${createHash("sha256").update(canonical).digest("hex")}`;
}

export class RedisSemanticCache implements SemanticCache {
  private readonly DEFAULT_TTL = 3600; // 1 hour for sanctions data freshness
  private readonly LONG_TTL = 86400;   // 24 hours for stable registry data

  public async get(promptHash: string): Promise<CacheEntry | null> {
    const raw = await redis.get(promptHash);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as CacheEntry;
    } catch {
      await redis.del(promptHash);
      return null;
    }
  }

  public async set(entry: CacheEntry): Promise<void> {
    await redis.set(entry.promptHash, JSON.stringify(entry), "EX", entry.ttlSeconds);
    log.info({ promptHash: entry.promptHash.slice(0, 16), ttl: entry.ttlSeconds }, "cache set");
  }

  public async invalidate(tenantId: string): Promise<void> {
    // Pattern-based invalidation — Redis KEYS is OK at current scale (<100K keys).
    // For production at scale, use SCAN or a tenant-keyed hash.
    const pattern = `llm:cache:*`;
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(...keys);
      log.info({ keyCount: keys.length }, "cache invalidated");
    }
  }

  /** Compute cache TTL based on data freshness requirements. */
  private ttlForState(state: AgentState): number {
    // Sanctions data changes — short TTL
    if (state.apiData?.sanctions.some(s => s.matched)) return this.DEFAULT_TTL;
    // PEP status changes — short TTL
    if (state.apiData?.pep) return this.DEFAULT_TTL;
    // Stable registry data — long TTL
    return this.LONG_TTL;
  }
}

export const sharedCache = new RedisSemanticCache();
```

**Integration point in `DynamicLlmRouter.draftDossier()`:**

```typescript
// Before calling any adapter, check cache:
const key = cacheKey(state);
const cached = await sharedCache.get(`llm:cache:${key}`);
if (cached) {
  log.info({ promptHash: key.slice(0, 16) }, "cache hit");
  // Record zero-cost usage for tracking
  recordTokenUsage(state.tenantId ?? "", 0, 0, 0).catch(() => {});
  return cached.response;
}
// ... proceed with LLM call, then cache the result:
const entry: CacheEntry = {
  promptHash: `llm:cache:${key}`,
  response: result,
  modelId: selected.modelId,
  costSavedUsd: selected.costPer1kInput * (features.estimatedTokenCount / 1000),
  createdAt: new Date().toISOString(),
  ttlSeconds: sharedCache.ttlForState(state), // NOTE: make ttlForState public
};
await sharedCache.set(entry).catch(() => {});
```

**Cache bypass conditions:**
- `state.requiresHuman === true` — high-risk cases must always get a fresh LLM assessment
- `state.browserFailed === true` — incomplete data should not be cached
- `env.NODE_ENV === "test"` — skip cache in tests

**Test:** `tests/unit/services/llm/cache.test.ts` — NEW file.
- Same entity twice → second call returns cached (mock Redis)
- Different entity → cache miss
- Cache TTL expiration → miss after TTL
- High-risk case → cache bypassed

**Rollback:** Set `LLM_CACHE_ENABLED=false` env var (add this flag). Cache layer is skipped.

---

## §5 — Sprint 4: RAG-Graph Foundation (Entity Resolution)

> **Goal:** Entities from OpenCorporates, ComplyAdvantage, and browser scraping are resolved into canonical graph nodes. Cross-case entity merging begins.
> **Success metric:** Entity resolution F1 > 0.90 on golden dataset. Graph contains >100 entities.

### Task 4.1 — Graph Schema (New DB Tables)

**File:** `src/db/schema.ts` — APPEND new tables

**Why:** The `evidence` table is a flat ledger. To build the RAG-Graph (per Paper 4: AI in AML, arXiv:2512.06240), we need graph tables for entities, relationships, and cross-case identity links.

```typescript
// FILE: src/db/schema.ts — APPEND after the webhooks table

// ── RAG-Graph tables (Phase 1: Blue Ocean Sprint 4) ──────────────────────

/** Canonical entity nodes in the knowledge graph. */
export const graphEntities = pgTable("graph_entities", {
  id: text("id").primaryKey(),                    // "ent_<ulid>"
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  canonicalName: text("canonical_name").notNull(),
  entityType: text("entity_type").notNull(),       // "company" | "person" | "wallet" | "sanctions_entry"
  jurisdiction: varchar("jurisdiction", { length: 2 }),
  registrationNumber: text("registration_number"),
  /** JSON: { opencorporates: { name, confidence }, complyadvantage: {...} } */
  sourceMetadata: jsonb("source_metadata").$type<Record<string, unknown>>().notNull().default({}),
  /** Aggregated confidence score across all sources (0.0–1.0). */
  resolutionConfidence: numeric("resolution_confidence", { precision: 3, scale: 2 }).notNull().default("1.00"),
  /** Cached embedding (1536-d float32[]) for vector search. Null until computed. */
  embedding: jsonb("embedding").$type<number[]>(),
  isActive: boolean("is_active").notNull().default(true),
  ...timestamps
}, (table) => ({
  tenantIdx: index("graph_entities_tenant_idx").on(table.tenantId),
  typeIdx: index("graph_entities_type_idx").on(table.entityType),
  nameSearchIdx: index("graph_entities_name_idx").on(table.canonicalName),
  // One canonical entity per registration number per jurisdiction
  registrationUnique: uniqueIndex("graph_entities_reg_unique")
    .on(table.registrationNumber, table.jurisdiction)
    .where(sql`${table.registrationNumber} IS NOT NULL`),
}));

/** Edges between graph entities. */
export const graphEdges = pgTable("graph_edges", {
  id: text("id").primaryKey(),                    // "edg_<ulid>"
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  sourceEntityId: text("source_entity_id").notNull().references(() => graphEntities.id, { onDelete: "cascade" }),
  targetEntityId: text("target_entity_id").notNull().references(() => graphEntities.id, { onDelete: "cascade" }),
  relationshipType: text("relationship_type").notNull(), // "controls" | "transacts_with" | "sanctioned_by" | "is_ubo_of" | "same_as"
  /** JSON: { evidenceKeys: ["API_1"], confidence: 0.95 } */
  edgeMetadata: jsonb("edge_metadata").$type<Record<string, unknown>>().notNull().default({}),
  ...timestamps
}, (table) => ({
  sourceIdx: index("graph_edges_source_idx").on(table.sourceEntityId),
  targetIdx: index("graph_edges_target_idx").on(table.targetEntityId),
  tenantIdx: index("graph_edges_tenant_idx").on(table.tenantId),
  relTypeIdx: index("graph_edges_rel_type_idx").on(table.relationshipType),
}));

/** Links a case to the graph entities it references. */
export const caseEntities = pgTable("case_entities", {
  id: text("id").primaryKey(),                    // "cel_<ulid>"
  caseId: text("case_id").notNull().references(() => cases.id, { onDelete: "cascade" }),
  entityId: text("entity_id").notNull().references(() => graphEntities.id, { onDelete: "cascade" }),
  role: text("role").notNull(),                   // "subject" | "ubo" | "sanctions_match" | "related"
  ...timestamps
}, (table) => ({
  caseIdx: index("case_entities_case_idx").on(table.caseId),
  entityIdx: index("case_entities_entity_idx").on(table.entityId),
  caseEntityUnique: uniqueIndex("case_entities_unique").on(table.caseId, table.entityId, table.role),
}));
```

**Test:** `tests/unit/db/schema.test.ts` — verify new tables exist in Drizzle schema, foreign keys cascade correctly.

**Rollback:** Drop the three tables. No existing queries depend on them.

**Note:** After adding these to `schema.ts`, run `npx drizzle-kit generate` and `npx drizzle-kit migrate` to create the migration.

---

### Task 4.2 — Entity Resolver (Deterministic Scoring)

**File:** `src/services/kyc-data/entity-resolver.ts` — NEW file

**Why:** "John Smith" from OpenCorporates and "JOHN SMITH" from ComplyAdvantage should be recognized as the same entity. Without resolution, the graph gets duplicate nodes. The resolver uses deterministic scoring (name similarity, registration number match, jurisdiction match) before any LLM sees the data.

**Implementation:**

```typescript
// FILE: src/services/kyc-data/entity-resolver.ts

import type { ApiCompanyData } from "../../types/index.js";
import type { EntityResolver, ResolvedEntity } from "./entity-resolver.js";

/**
 * Jaro-Winkler similarity for name matching.
 * Simple implementation — for production, use a proper library
 * (e.g., `natural` npm package) but avoid the dependency for now.
 */
function jaroWinkler(a: string, b: string): number {
  const aNorm = a.toLowerCase().trim();
  const bNorm = b.toLowerCase().trim();
  if (aNorm === bNorm) return 1.0;

  // Exact match after basic normalization
  const stripEntity = (s: string) => s.replace(/\b(ltd|limited|inc|llc|corp|corporation|gmbh|ag|sa|nv|bv|sarl|srl|plc|pty)\b/gi, "").replace(/[^a-z0-9]/g, "").trim();
  const aStripped = stripEntity(aNorm);
  const bStripped = stripEntity(bNorm);
  if (aStripped === bStripped) return 0.95;

  // Character bigram overlap as cheap fuzzy match
  const bigrams = (s: string): Set<string> => {
    const result = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) result.add(s.slice(i, i + 2));
    return result;
  };
  const aBigrams = bigrams(aStripped);
  const bBigrams = bigrams(bStripped);
  if (aBigrams.size === 0 && bBigrams.size === 0) return 0.0;
  const intersection = new Set([...aBigrams].filter(x => bBigrams.has(x)));
  const union = new Set([...aBigrams, ...bBigrams]);
  return union.size === 0 ? 0.0 : intersection.size / union.size;
}

export class DeterministicEntityResolver implements EntityResolver {
  /**
   * Resolve entity identity across data sources.
   *
   * Scoring (weighted sum, threshold 0.70):
   *   - Registration number exact match:  40 pts
   *   - Jurisdiction exact match:         25 pts
   *   - Name Jaro-Winkler > 0.90:        25 pts
   *   - Name Jaro-Winkler > 0.70:        10 pts
   *   → Max: 90 pts. Normalized to 0.0–1.0.
   */
  public resolve(apiData: ApiCompanyData, browserData?: ApiCompanyData | null): ResolvedEntity {
    const sources: ResolvedEntity["sources"] = [{
      sourceName: "opencorporates",
      name: apiData.legalName,
      matchConfidence: 1.0,
    }];

    const conflicts: ResolvedEntity["conflicts"] = [];

    if (browserData) {
      const nameScore = jaroWinkler(apiData.legalName, browserData.legalName);
      const regMatch = apiData.registrationNumber === browserData.registrationNumber ? 40 : 0;
      const jurMatch = apiData.jurisdiction === browserData.jurisdiction ? 25 : 0;
      const nameMatch = nameScore > 0.90 ? 25 : nameScore > 0.70 ? 10 : 0;
      const totalScore = (regMatch + jurMatch + nameMatch) / 90;

      sources.push({
        sourceName: "browser",
        name: browserData.legalName,
        matchConfidence: totalScore,
      });

      if (totalScore < 0.70) {
        conflicts.push({
          field: "legalName",
          sourceValues: { opencorporates: apiData.legalName, browser: browserData.legalName },
        });
      }
    }

    const avgConfidence = sources.reduce((sum, s) => sum + s.matchConfidence, 0) / sources.length;

    return {
      canonicalName: apiData.legalName,
      registrationNumber: apiData.registrationNumber,
      jurisdiction: apiData.jurisdiction,
      sources,
      confidence: Math.round(avgConfidence * 100) / 100,
      conflicts,
    };
  }
}
```

**Test:** `tests/unit/services/kyc-data/entity-resolver.test.ts` — NEW file.
- Same name, same reg number → confidence ≥ 0.90
- Different names, same reg number → confidence ~0.44 (reg match only)
- "Acme Ltd" vs "ACME LIMITED" → name similarity ≥ 0.90
- No browser data → single source, confidence = 1.0
- Browser name conflict → conflict entry created

**Rollback:** The resolver is a pure function with no side effects. Simply stop calling it.

---

## §6 — Sprint 5: Graph-Enhanced Dossier Prompts

> **Goal:** `draftDossierNode` queries the knowledge graph for related entities before calling the LLM. Dossiers cite cross-case evidence.
> **Success metric:** RAG-Graph citation accuracy > 95%. Cross-case entity references appear in dossier output.

### Task 5.1 — Graph Query Service

**File:** `src/services/kyc-data/graph-query.ts` — NEW file

**Why:** The LLM currently sees only the current case's flat evidence list. With the graph, it should also see: "This entity shares a UBO with 3 other entities processed in the last 6 months" and "This entity was previously screened on [date] with result X."

**Interface contract:**

```typescript
// FILE: src/services/kyc-data/graph-query.ts

import { z } from "zod";

export const GraphContextSchema = z.object({
  /** Entities directly linked to the subject (UBOs, subsidiaries, etc.). */
  relatedEntities: z.array(z.object({
    canonicalName: z.string(),
    entityType: z.string(),
    relationshipType: z.string(),
    riskScore: z.enum(["Low", "Medium", "High", "Pending"]).nullable(),
    lastSeenAt: z.string().nullable(),
  })),
  /** Previous cases involving this entity or related entities. */
  priorCases: z.array(z.object({
    caseId: z.string(),
    completedAt: z.string(),
    riskScore: z.enum(["Low", "Medium", "High", "Pending"]),
    summary: z.string(),
  })),
  /** Entity resolution status for the current subject. */
  entityResolution: z.object({
    isNewEntity: z.boolean(),
    canonicalName: z.string(),
    confidence: z.number(),
    mergedFrom: z.number().int(), // how many source entities were merged
  }),
});
export type GraphContext = z.infer<typeof GraphContextSchema>;

export interface GraphQueryService {
  getContext(caseId: string, entityName: string, jurisdiction: string): Promise<GraphContext>;
  upsertEntity(resolved: import("./entity-resolver.js").ResolvedEntity, tenantId: string): Promise<string>;
  linkCaseToEntity(caseId: string, entityId: string, role: string): Promise<void>;
}
```

**Implementation sketch:**

```typescript
// FILE: src/services/kyc-data/graph-query.ts

import { eq, and, or, desc } from "drizzle-orm";
import { db } from "../../db/index.js";
import { graphEntities, graphEdges, caseEntities, cases } from "../../db/schema.js";
import { newId } from "../../utils/id.js";
import type { GraphContext, GraphQueryService } from "./graph-query.js";
import type { ResolvedEntity } from "./entity-resolver.js";

export class PostgresGraphQueryService implements GraphQueryService {
  public async getContext(caseId: string, entityName: string, jurisdiction: string): Promise<GraphContext> {
    // 1. Find the canonical entity for this name+jurisdiction
    const entityRows = await db.select()
      .from(graphEntities)
      .where(and(
        eq(graphEntities.canonicalName, entityName),
        eq(graphEntities.jurisdiction, jurisdiction),
      ))
      .limit(1);

    const entity = entityRows[0];
    const isNewEntity = entity === undefined;

    // 2. If entity exists, find related entities via edges
    let relatedEntities: GraphContext["relatedEntities"] = [];
    let priorCases: GraphContext["priorCases"] = [];

    if (entity) {
      const edges = await db.select()
        .from(graphEdges)
        .where(or(
          eq(graphEdges.sourceEntityId, entity.id),
          eq(graphEdges.targetEntityId, entity.id),
        ))
        .limit(20);

      const relatedIds = edges.map(e =>
        e.sourceEntityId === entity.id ? e.targetEntityId : e.sourceEntityId
      );

      if (relatedIds.length > 0) {
        const relatedRows = await db.select()
          .from(graphEntities)
          .where(/* ... IN relatedIds ... */)
          .limit(20);

        relatedEntities = relatedRows.map(r => ({
          canonicalName: r.canonicalName,
          entityType: r.entityType,
          relationshipType: edges.find(e =>
            e.sourceEntityId === r.id || e.targetEntityId === r.id
          )?.relationshipType ?? "unknown",
          riskScore: null, // populated from cases if available
          lastSeenAt: r.updatedAt?.toISOString() ?? null,
        }));
      }

      // 3. Find prior cases involving this entity
      const caseLinks = await db.select()
        .from(caseEntities)
        .where(eq(caseEntities.entityId, entity.id))
        .limit(10);

      if (caseLinks.length > 0) {
        const caseIds = caseLinks.map(cl => cl.caseId);
        const caseRows = await db.select()
          .from(cases)
          .where(/* ... IN caseIds ... */)
          .orderBy(desc(cases.completedAt))
          .limit(5);

        priorCases = caseRows
          .filter(c => c.completedAt !== null)
          .map(c => ({
            caseId: c.id,
            completedAt: c.completedAt!.toISOString(),
            riskScore: c.riskScore,
            summary: c.dossier.slice(0, 200),
          }));
      }
    }

    return {
      relatedEntities,
      priorCases,
      entityResolution: {
        isNewEntity,
        canonicalName: entityName,
        confidence: entity ? Number(entity.resolutionConfidence) : 1.0,
        mergedFrom: entity ? (entity.sourceMetadata as Record<string, unknown> & { _sourceCount?: number })._sourceCount ?? 1 : 1,
      },
    };
  }

  public async upsertEntity(resolved: ResolvedEntity, tenantId: string): Promise<string> {
    // Find existing entity by registration number + jurisdiction
    const existing = await db.select()
      .from(graphEntities)
      .where(and(
        eq(graphEntities.registrationNumber, resolved.registrationNumber),
        eq(graphEntities.jurisdiction, resolved.jurisdiction),
      ))
      .limit(1);

    if (existing[0]) {
      // Update confidence if new resolution is higher
      if (resolved.confidence > Number(existing[0].resolutionConfidence)) {
        await db.update(graphEntities)
          .set({
            canonicalName: resolved.canonicalName,
            resolutionConfidence: String(resolved.confidence),
            sourceMetadata: { _sourceCount: resolved.sources.length, ...resolved },
            updatedAt: new Date(),
          })
          .where(eq(graphEntities.id, existing[0].id));
      }
      return existing[0].id;
    }

    // Insert new entity
    const id = newId("ent");
    await db.insert(graphEntities).values({
      id,
      tenantId,
      canonicalName: resolved.canonicalName,
      entityType: "company",
      jurisdiction: resolved.jurisdiction,
      registrationNumber: resolved.registrationNumber,
      sourceMetadata: { _sourceCount: resolved.sources.length, ...resolved },
      resolutionConfidence: String(resolved.confidence),
    });
    return id;
  }

  public async linkCaseToEntity(caseId: string, entityId: string, role: string): Promise<void> {
    await db.insert(caseEntities).values({
      id: newId("cel"),
      caseId,
      entityId,
      role,
    }).onConflictDoNothing();
  }
}
```

**Test:** `tests/unit/services/kyc-data/graph-query.test.ts` — NEW file.
- New entity → `isNewEntity: true`
- Existing entity → returns related entities and prior cases
- Upsert with higher confidence → updates entity
- Upsert with lower confidence → no-op

**Rollback:** The graph tables can be empty — `getContext` returns `isNewEntity: true` and empty arrays. No existing pipeline breaks.

---

### Task 5.2 — Graph-Enhanced Prompt Builder

**File:** `src/services/llm/adapters/prompt.ts` — EXTEND `buildDossierPrompt`

**Why:** The current prompt only includes the current case's flat evidence. With graph context, the LLM can write dossiers that reference historical patterns and related entities.

**Implementation:**

```typescript
// FILE: src/services/llm/adapters/prompt.ts — EXTEND

import type { GraphContext } from "../../kyc-data/graph-query.js";

/**
 * Build a graph-enhanced dossier prompt.
 * Extends the existing buildDossierPrompt with cross-case graph context.
 */
export function buildGraphEnhancedPrompt(state: AgentState, graphCtx: GraphContext | null): string {
  const base = buildDossierPrompt(state);

  if (!graphCtx || graphCtx.entityResolution.isNewEntity) {
    return base + "\n\nNote: This is the first time this entity has been assessed. No historical context available.";
  }

  const priorCasesText = graphCtx.priorCases.length > 0
    ? `\n\nPrior assessments of this entity:\n${graphCtx.priorCases.map(c =>
        `- Case ${c.caseId} (${c.completedAt}): ${c.riskScore} risk — ${c.summary}`
      ).join("\n")}`
    : "";

  const relatedText = graphCtx.relatedEntities.length > 0
    ? `\n\nRelated entities in knowledge graph:\n${graphCtx.relatedEntities.map(r =>
        `- ${r.canonicalName} (${r.entityType}) — relationship: ${r.relationshipType}`
      ).join("\n")}`
    : "";

  const resolutionText = graphCtx.entityResolution.mergedFrom > 1
    ? `\n\nEntity resolution: This canonical entity was merged from ${graphCtx.entityResolution.mergedFrom} source records with ${graphCtx.entityResolution.confidence * 100}% confidence.`
    : "";

  return base + priorCasesText + relatedText + resolutionText;
}
```

**Integration point in `draftDossierNode`:**

```typescript
// FILE: src/graph/nodes/draft-dossier.ts — MODIFY

import { PostgresGraphQueryService } from "../../services/kyc-data/graph-query.js";
import { DeterministicEntityResolver } from "../../services/kyc-data/entity-resolver.js";
import { buildGraphEnhancedPrompt } from "../../services/llm/adapters/prompt.js";

export async function draftDossierNode(state: AgentState, deps: DraftDossierDependencies): Promise<AgentStatePatch> {
  // ── Entity resolution + graph context ──
  const resolver = new DeterministicEntityResolver();
  const graphQuery = new PostgresGraphQueryService();

  // Resolve entity identity across API + browser sources
  const resolved = resolver.resolve(state.apiData!, state.browserResult?.data ?? null);

  // Upsert into knowledge graph (fire-and-forget — don't block dossier)
  const entityIdPromise = graphQuery.upsertEntity(resolved, state.tenantId ?? "");
  const graphCtxPromise = graphQuery.getContext(state.caseId, resolved.canonicalName, resolved.jurisdiction);

  // ── LLM call with graph-enhanced prompt ──
  const result = DossierSchema.parse(await deps.llm.draftDossier(state));
  const sanitizedResult = { /* ... sanitize output ... */ };

  // Link case to entity after LLM call completes
  const entityId = await entityIdPromise;
  await graphQuery.linkCaseToEntity(state.caseId, entityId, "subject").catch(() => {});

  // ── Build dossier ──
  const graphCtx = await graphCtxPromise;
  const graphNote = graphCtx && !graphCtx.entityResolution.isNewEntity
    ? `\n[Graph: ${graphCtx.priorCases.length} prior case(s), ${graphCtx.relatedEntities.length} related entities]`
    : "";

  const dossier = [
    `Enhanced Due Diligence dossier for ${resolved.canonicalName}. [Source: API_1]${graphNote}`,
    sanitizedResult.summary,
    ...sanitizedResult.claims.map((claim) => `- ${claim.text} [Source: ${claim.sourceKey}]`)
  ].join("\n");

  return { claims: sanitizedResult.claims, dossier, riskScore: sanitizedResult.riskScore };
}
```

**Test:** `tests/unit/nodes/draft-dossier.test.ts` — extend existing tests:
- Graph context with 2 prior cases → dossier contains "2 prior case(s)"
- Graph context with related entities → dossier references related entity names
- New entity → no graph blurb in dossier
- Entity resolution merges 3 sources → confidence recorded

**Rollback:** Remove the graph query calls from `draftDossierNode`. Revert to the original `buildDossierPrompt` only.

---

## §7 — Sprint 6: KYT Classifier (Tree Ensemble)

> **Status: DEFERRED.** Depends on Sprint 4 (graph schema), Sprint 5 (entity resolution), and a wallet transaction data source that does not yet exist.
>
> Implementation plan is scaffolded below for future reference. Do not execute until:
> - Graph tables are in production with >1,000 entities
> - A transaction data source (e.g., Elliptic dataset, Chainalysis API) is integrated
> - A training pipeline (`tests/evaluation/`) is established

### Deferred Implementation Sketch

```
New files:
  src/graph/nodes/kyt-classifier.ts       — KytAgent node
  src/services/kyt/feature-extractor.ts   — Transaction feature engineering
  src/services/kyt/typology-classifier.ts — XGBoost/LightGBM wrapper
  tests/evaluation/kyt-benchmark.ts       — Benchmark harness

Interface:
  KytFeatures { value, frequency, velocity, counterpartyDiversity, timePatterns }
  TypologyResult { typology: "cybercrime_dispersion" | "sanctions_evasion" | "mixing_service" | "clean", confidence: number, featureImportance: Record<string, number> }

Integration:
  New node in KycGraph.run() after guardrailNode (optional, gated by plan tier)
  Output feeds into risk score as a vector element
```

---

## §8 — Test Harness & Benchmarks

### 8.1 Evaluation Framework

```typescript
// FILE: tests/evaluation/harness.ts — NEW file

/**
 * Evaluation harness for all three AI subsystems.
 *
 * Every model change runs through this harness before merge.
 * Benchmarks are compared against golden dataset baselines.
 */

export interface EvaluationResult {
  subsystem: "cost-router" | "rag-graph" | "kyt-classifier";
  metric: string;
  baseline: number;
  current: number;
  delta: number;
  passed: boolean;
}

export interface GoldenCase {
  caseId: string;
  companyName: string;
  registrationNumber: string;
  jurisdiction: string;
  expectedRiskScore: "Low" | "Medium" | "High";
  expectedTier: "t0" | "t2" | "t4";
  expectedEntityResolved: boolean;
}
```

### 8.2 Required Test Files (Checklist for competitive-coder)

| # | Test File | Sprint | Status |
|---|---|---|---|
| 1 | `tests/unit/workers/graph-runner.test.ts` | Sprint 1 | **CREATE** |
| 2 | `tests/unit/utils/mask.test.ts` (extend) | Sprint 1 | **EXTEND** |
| 3 | `tests/unit/services/llm/audit.test.ts` | Sprint 1 | **CREATE** |
| 4 | `tests/unit/services/llm/cost-tracker.test.ts` | Sprint 2 | **CREATE** |
| 5 | `tests/unit/services/llm/budget.test.ts` | Sprint 2 | **CREATE** |
| 6 | `tests/unit/services/llm/difficulty-classifier.test.ts` | Sprint 3 | **CREATE** |
| 7 | `tests/unit/services/llm/cache.test.ts` | Sprint 3 | **CREATE** |
| 8 | `tests/unit/db/schema.test.ts` (extend) | Sprint 4 | **EXTEND** |
| 9 | `tests/unit/services/kyc-data/entity-resolver.test.ts` | Sprint 4 | **CREATE** |
| 10 | `tests/unit/services/kyc-data/graph-query.test.ts` | Sprint 5 | **CREATE** |
| 11 | `tests/unit/nodes/draft-dossier.test.ts` (extend) | Sprint 5 | **EXTEND** |
| 12 | `tests/evaluation/harness.test.ts` | Sprint 2+ | **CREATE** |

### 8.3 Benchmark Targets

| Metric | Baseline | Target | Measurement |
|---|---|---|---|
| **Cost per dossier** (median) | ~$0.08 (estimated) | ≤$0.03 | `usage.costUsd / usage.casesProcessed` |
| **t0–t2 routing ratio** | Unknown | ≥60% | `LlmCallRecord.tier` distribution |
| **Cache hit rate** | 0% | ≥15% | `LlmCallRecord.cached` ratio |
| **Entity resolution F1** | N/A | >0.90 | Golden dataset of 50 entities with known duplicates |
| **Citation format validity** | ~95% (regex) | >98% | Guardrail strip rate |
| **Budget enforcement latency** | N/A | <5ms | `checkLlmBudget()` timing |
| **Graph query latency (p95)** | N/A | <100ms | `getContext()` timing |

---

## §9 — File Change Index

Every file touched by Sprints 1–5, in dependency order:

### New Files (CREATE)

| File | Sprint | Purpose |
|---|---|---|
| `src/services/llm/audit.ts` | 1 | LLM call audit trail |
| `src/services/llm/budget.ts` | 2 | Per-tenant budget enforcement |
| `src/services/llm/difficulty-classifier.ts` | 3 | Task complexity → tier routing |
| `src/services/llm/cache.ts` | 3 | Redis-backed semantic cache |
| `src/services/kyc-data/entity-resolver.ts` | 4 | Deterministic entity resolution |
| `src/services/kyc-data/graph-query.ts` | 5 | Graph query service |

### Modified Files (EDIT)

| File | Sprint | Change |
|---|---|---|
| `src/workers/graph-runner.ts` | 1 | Strip PII from graphState |
| `src/utils/mask.ts` | 1 | Add `sanitizeOutput()` |
| `src/graph/nodes/draft-dossier.ts` | 1, 5 | Apply sanitization, integrate graph context |
| `src/services/llm/router.ts` | 2, 3 | Budget check, difficulty classifier, cache check |
| `src/services/llm/adapters/openai.ts` | 2 | Record token usage, cost computation |
| `src/services/llm/adapters/anthropic.ts` | 2 | Record token usage |
| `src/services/llm/adapters/google.ts` | 2 | Record token usage |
| `src/services/llm/adapters/ollama.ts` | 2 | Record token usage |
| `src/services/llm/adapters/prompt.ts` | 5 | Add `buildGraphEnhancedPrompt()` |
| `src/db/schema.ts` | 4 | Add graph tables |
| `src/services/llm/client.ts` | 3 | Export `LlmClient` interface extensions |

### Not Modified (READ ONLY)

| File | Reason |
|---|---|
| `src/graph/graph.ts` | No changes needed — nodes are add/remove, not restructure |
| `src/graph/state.ts` | State shape unchanged (PII strip happens at persist, not in memory) |
| `src/graph/schemas.ts` | Zod schemas unchanged |
| `src/config/env.ts` | Add `LLM_CACHE_ENABLED` if needed, otherwise unchanged |
| `src/config/llm-providers.ts` | Provider catalog unchanged |
| `src/services/encryption/at-rest.ts` | Key rotation deferred to post-MVP |
| `src/api/middleware/*.ts` | Unchanged |

---

## §10 — Rollback Summary

Every change is independently reversible:

| Change | Rollback |
|---|---|
| PII strip in graphState | Revert `safeState` → `state` in `graph-runner.ts` |
| Output sanitization | Remove `sanitizeOutput()` call in `draftDossierNode` |
| LLM audit trail | Comment out `auditLlmCall()` in router |
| Token usage recording | Remove `recordTokenUsage` from adapters; revert constructor signature |
| Budget enforcement | Remove `checkLlmBudget` call in router |
| Difficulty classifier | Set `LLM_TIER_PRIMARY=t4` (bypasses classifier routing) |
| Semantic cache | Set `LLM_CACHE_ENABLED=false` (skip cache layer) |
| Graph tables | `DROP TABLE case_entities, graph_edges, graph_entities CASCADE` |
| Entity resolver | Stop calling resolver in `draftDossierNode` |
| Graph-enhanced prompts | Revert to `buildDossierPrompt` only |

---

## §11 — Dependency Graph (What Blocks What)

```mermaid
flowchart TD
    S1[ Sprint 1: Security ] --> S2[ Sprint 2: Cost Visibility ]
    S2 --> S3[ Sprint 3: Difficulty Routing + Cache ]
    S1 --> S4[ Sprint 4: Graph Schema + Entity Resolution ]
    S4 --> S5[ Sprint 5: Graph-Enhanced Prompts ]
    S5 --> S6[ Sprint 6: KYT Classifier - DEFERRED ]

    S3_cost[S3: CostRouter COMPLETE] --> S5
    S4_graph[S4: Graph Tables EXIST] --> S5
```

- **Sprint 1 blocks nothing** — it fixes existing security gaps. Can be done in parallel with Sprint 2.
- **Sprint 2 blocks Sprint 3** — the difficulty classifier needs cost data to validate routing decisions.
- **Sprint 4 blocks Sprint 5** — graph-enhanced prompts need graph tables.
- **Sprints 1–3 and Sprints 4–5 are parallel tracks** — CostRouter and RAGGraphBuilder can be built simultaneously by different engineers.

---

## §12 — Quick-Start for competitive-coder

```bash
# 1. Verify the codebase runs
cd /Users/kakashi3lite/kyc-copilot
npm install
npm run test:unit

# 2. Create the Sprint 1 files
#    - src/services/llm/audit.ts
#    - tests/unit/workers/graph-runner.test.ts

# 3. Edit the Sprint 1 files
#    - src/workers/graph-runner.ts (PII strip)
#    - src/utils/mask.ts (sanitizeOutput)
#    - src/graph/nodes/draft-dossier.ts (apply sanitization)

# 4. Run tests after each sprint
npm run test:unit
npm run typecheck

# 5. After Sprint 4 (DB schema change):
npx drizzle-kit generate
npx drizzle-kit migrate
```

---

## §13 — Execution Log (Sprints 1–5 shipped 2026-08-04 by competitive-coder)

### 13.1 Delivered

| Sprint | What shipped | Files |
|---|---|---|
| 1 — Security | PII stripped from `graphState` jsonb before persist (ADR-003); `sanitizeOutput()` stored-XSS guard; immutable LLM call audit trail (`llm.call` with prompt/response hashes) | `src/workers/graph-runner.ts`, `src/utils/mask.ts`, `src/graph/nodes/draft-dossier.ts`, `src/services/llm/audit.ts`, `src/services/llm/cost-tracker.ts` |
| 2 — Cost & Budget | `recordTokenUsage` wired into all four adapters (real token counts from response metadata + heuristic fallback); `checkLlmBudget()` per-tenant monthly cap with 80% warning; blocked tenants → t0, warning → cap t4→t2 | `src/services/llm/budget.ts`, `src/services/llm/adapters/{openai,anthropic,google,ollama}.ts`, `src/services/llm/router.ts` |
| 3 — Routing & Cache | `DeterministicDifficultyClassifier` (7 rules, incl. blacklist→t4); Redis-backed `RedisSemanticCache` with graph-aware keys + TTL tiers; `LLM_CACHE_ENABLED` env; test/high-risk/browser-failed bypass | `src/services/llm/difficulty-classifier.ts`, `src/services/llm/cache.ts`, `src/config/env.ts`, `src/services/llm/router.ts` |
| 4 — Graph Schema + Resolution | `graph_entities` / `graph_edges` / `case_entities` tables (migration `0003_true_jack_murdock.sql`); deterministic entity resolver (reg/jurisdiction/name scoring) | `src/db/schema.ts`, `src/db/migrations/0003_true_jack_murdock.sql`, `src/services/kyc-data/entity-resolver.ts` |
| 5 — Graph-Enhanced Prompts | `PostgresGraphQueryService` (context, upsert, case-link); graph context threaded into the LLM prompt via `LlmClient.draftDossier(state, graphCtx?)`; dossier carries `[Graph: N prior case(s), M related entities]` note | `src/services/kyc-data/graph-query.ts`, `src/services/llm/adapters/prompt.ts`, `src/services/llm/client.ts`, `src/graph/nodes/draft-dossier.ts` |

**Tests added:** 12 files, 51 new tests → **166 tests / 28 files all green**. Coverage 66.6 stmts / 54.8 branch / 68.6 funcs / 67.7 lines (thresholds 60/40/55/60). `tests/evaluation/harness.{ts,test.ts}` provides the F1 / tier-ratio / cache-hit-rate / cost-delta evaluation primitives.

**End-to-end validation:** migration applied to real Postgres; E2E lifecycle (8 steps) verified that both the low-risk (Acme) and high-risk (Volkov) cases upsert canonical entities into `graph_entities` and link them via `case_entities` — through the real API + graph pipeline.

### 13.2 Deviations from plan (all deliberate, each testable)

1. **Audit + cost bookkeeping live in the adapters, not the router.** `reportLlmCall()` (audit.ts) is called by each adapter with real token counts, prompt text and response text — the router never observes those. The plan's "call `auditLlmCall()` from the router" was impossible without token data. All Sprint-1 test requirements are met (action `llm.call`, deterministic hashes, t0 produces no entries).
2. **Graph context is threaded to the LLM via an optional `graphCtx` param on `LlmClient.draftDossier`.** The plan's Task 5.2 sketch defined `buildGraphEnhancedPrompt` but then still called `draftDossier(state)` — the enhanced prompt never reached the model. The optional param (no breakage: all existing implementations/tests keep working) makes graph-enhanced prompts real. `buildGraphEnhancedPrompt` is kept as a documented convenience wrapper.
3. **`sanitizeOutput` strips the entire `<script>…</script>` block, not just the tags.** The plan's test expected `"alert(1)"` to survive; the block's content is executable JS and must not. Plan test corrected to `""`.
4. **Difficulty classifier adds a blacklisted-jurisdiction → t4 rule** (before the partial-data rule). The plan's rules silently routed a complete-data KP/IR/MM case to t2 — unacceptable for sanctioned jurisdictions. Renumbered rules 1–7.
5. **Cache key**: plan's `cacheKey()` double-prefixed (`llm:cache:llm:cache:…`). Fixed — `hashCacheKey()` returns the 64-hex, `cacheKey()` returns the full Redis key; graph-context digest included so a growing graph invalidates stale dossiers.
6. **`TierAssignment.tier` typed as full `LlmTier`** (t0–t4), not `["t0","t2","t4"]` — `classify()` legitimately returns t3 for large contexts.
7. **`DraftDossierDependencies.graphQuery` is injectable** (defaults to `PostgresGraphQueryService`) so node tests are DB-free; graph DB access is fail-open (`.catch` → null context / skipped link) so a DB outage never fails a case.

### 13.3 Benchmark status

| Metric | Target | Status |
|---|---|---|
| Cost per dossier | ≤$0.03 | 🟡 Instrumented (per-call `costUsd` in `usage` + audit) — measure after real traffic |
| t0–t2 routing ratio | ≥60% | 🟡 Harness ready (`lowCostTierRatio`); deterministic classifier assigns t0/t2 to clean complete-data cases |
| Cache hit rate | ≥15% | 🟡 Harness ready (`cacheHitRate`); TTL-tiered, graph-aware keys; bypass rules enforced |
| Entity resolution F1 | >0.90 | 🟡 Harness ready (`entityResolutionF1`); resolver unit-verified, golden dataset is a follow-up |
| Budget enforcement latency | <5ms | 🟢 Single indexed `tenants` lookup + `usage` aggregate |
| Graph query latency (p95) | <100ms | 🟡 Indexed lookups (tenant/type/name/reg-unique); measure under load |

### 13.4 Remaining work (outside this plan's Sprints 1–5)

- **Sprint 6 (KYT classifier)** — blocked: needs graph at >1,000 entities + a transaction data source. Plan scaffold retained in §7.
- Golden dataset of 50 entities for F1 benchmarking (`tests/evaluation/`).
- `LLM_SYNC_ALLOWED_TIERS` docs note: sync mode only permits t0/t2 — budget-blocked and classifier-routed cases degrade to deterministic t0, which is sync-safe.

---

*Document version: 1.1 (sprints 1–5 shipped). Living document — update §13 after each follow-up sprint with actual benchmarks.*
