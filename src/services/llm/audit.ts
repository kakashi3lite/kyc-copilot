/**
 * LLM call audit trail — Sprint 1 security foundation.
 *
 * AMLD6 Article 8 and MiCA Article 68 require regulated entities to be able
 * to explain AI-assisted decisions. This module records an immutable audit
 * log entry for every LLM call: it stores SHA-256 hashes of the prompt and
 * response (for integrity verification) plus the token/cost/latency metrics,
 * and accumulates the same metrics into the monthly `usage` table for
 * billing (via `recordTokenUsage`).
 *
 * Design note: `reportLlmCall()` is invoked from the LLM adapters (not the
 * router) because the adapters are the only layer that observes the actual
 * prompt text, response text and token metadata of a completed call. It is
 * fire-and-forget from the adapter's perspective (`.catch(() => {})`) so
 * cost/audit bookkeeping never blocks the dossier response.
 */

import { createHash } from "node:crypto";
import { writeAuditLog } from "../audit/logger.js";
import { recordTokenUsage, type LlmCallRecord } from "./cost-tracker.js";

/**
 * SHA-256 hex digests of a prompt/response pair. Deterministic — the same
 * text always yields the same hashes, which is what makes the audit trail
 * integrity-verifiable.
 */
export function hashPromptResponse(promptText: string, responseText: string): { promptHash: string; responseHash: string } {
  return {
    promptHash: createHash("sha256").update(promptText).digest("hex"),
    responseHash: createHash("sha256").update(responseText).digest("hex"),
  };
}

/**
 * Write an immutable audit log entry for each LLM call.
 *
 * Stores hashes of prompt/response for integrity verification; full text
 * replay is available via the evidence ledger if needed. The hashes are
 * recomputed here from the actual text (never trusted from the caller),
 * so the entry is always self-consistent.
 */
export async function auditLlmCall(record: LlmCallRecord, promptText: string, responseText: string): Promise<void> {
  const { promptHash, responseHash } = hashPromptResponse(promptText, responseText);

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

/**
 * Audit a completed LLM call AND accumulate its cost into the monthly
 * `usage` row. Equivalent to calling {@link auditLlmCall} followed by
 * {@link recordTokenUsage}; kept as a single helper so adapters can record
 * both side effects in one place. Hashes are derived from the text.
 */
export async function reportLlmCall(record: Omit<LlmCallRecord, "promptHash" | "responseHash">, promptText: string, responseText: string): Promise<void> {
  const { promptHash, responseHash } = hashPromptResponse(promptText, responseText);
  const full: LlmCallRecord = { ...record, promptHash, responseHash };
  await auditLlmCall(full, promptText, responseText);
  await recordTokenUsage(full.tenantId, full.promptTokens, full.completionTokens, full.costUsd);
}
