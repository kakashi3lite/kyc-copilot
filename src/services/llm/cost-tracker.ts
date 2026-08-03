import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/index.js";
import { usage } from "../../db/schema.js";
import { monthKey } from "../../utils/date.js";
import { newId } from "../../utils/id.js";

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

/**
 * Compute LLM call cost from token counts and per-1K pricing.
 * Pure function — unit-testable without any adapter or network.
 *
 * cost = (promptTokens/1000 * costPer1kInput) + (completionTokens/1000 * costPer1kOutput)
 */
export function computeCostUsd(promptTokens: number, completionTokens: number, costPer1kInput: number, costPer1kOutput: number): number {
  return (promptTokens / 1000) * costPer1kInput + (completionTokens / 1000) * costPer1kOutput;
}

export async function recordTokenUsage(tenantId: string, promptTokens: number, completionTokens: number, costUsd: number): Promise<void> {
  const month = monthKey();
  const existing = await db.select().from(usage).where(and(eq(usage.tenantId, tenantId), eq(usage.month, month))).limit(1);
  const row = existing[0];
  if (row === undefined) {
    await db.insert(usage).values({ id: newId("use"), tenantId, month, promptTokens, completionTokens, costUsd: costUsd.toFixed(6) });
  } else {
    await db.update(usage).set({ promptTokens: row.promptTokens + promptTokens, completionTokens: row.completionTokens + completionTokens, costUsd: (Number(row.costUsd) + costUsd).toFixed(6), updatedAt: new Date() }).where(eq(usage.id, row.id));
  }
}
