/**
 * Per-tenant LLM budget enforcement — Sprint 2.
 *
 * `tenants.llmBudgetUsd` exists in the schema but nothing enforced it; a
 * tenant could burn unbounded LLM spend. This module reads cumulative
 * `usage.costUsd` for the current month and compares it against the
 * tenant's monthly cap before any LLM call is made.
 *
 * Returns `{ allowed: false }` when the tenant is missing/disabled or the
 * monthly spend has reached the cap, and `{ allowed: true, warning: true }`
 * once spend crosses 80% of the cap (the router downgrades t4 → t2).
 */

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
 * Returns `{ allowed: false }` when:
 *   - Tenant not found or disabled
 *   - Monthly spend >= llmBudgetUsd
 *
 * Returns `{ allowed: true, warning: true }` when spend >= 80% of budget.
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
