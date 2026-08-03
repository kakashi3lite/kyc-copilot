import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { tenants, usage } from "../../db/schema.js";
import { monthKey } from "../../utils/date.js";
import { newId } from "../../utils/id.js";
import { childLogger } from "../../config/logger.js";
import { StripeBillingClient } from "./stripe.js";

const log = childLogger({ component: "usage-meter" });
const stripeClient = new StripeBillingClient();

export interface UsageSummary { tenantId: string; month: string; casesProcessed: number; apiCalls: number; manualCostAvoidedEur: number; timeSavedHours: number; }

export async function incrementUsage(tenantId: string, field: "casesProcessed" | "apiCalls", amount = 1): Promise<void> {
  const month = monthKey();
  const existing = await db.select().from(usage).where(and(eq(usage.tenantId, tenantId), eq(usage.month, month))).limit(1);
  const row = existing[0];
  if (row === undefined) {
    await db.insert(usage).values({ id: newId("use"), tenantId, month, casesProcessed: field === "casesProcessed" ? amount : 0, apiCalls: field === "apiCalls" ? amount : 0 });
  } else {
    await db.update(usage).set({ [field]: row[field] + amount, updatedAt: new Date() }).where(eq(usage.id, row.id));
  }
}

/**
 * Report metered usage to Stripe after a case is processed. Fail-soft:
 * - No Stripe configured            → no-op
 * - Tenant has no subscription      → no-op
 * - Stripe API down                 → logged, no-op (usage rows in our DB
 *                                    remain the source of truth for billing)
 *
 * The idempotency key is `case:<caseId>` — Stripe dedupes retries so a
 * case is never double-counted even if the worker runs it more than once.
 */
export async function reportMeteredUsageToStripe(tenantId: string, caseId: string, quantity = 1): Promise<void> {
  const tenant = await db.select({ stripeSubscriptionId: tenants.stripeSubscriptionId }).from(tenants)
    .where(eq(tenants.id, tenantId)).limit(1);
  const subscriptionId = tenant[0]?.stripeSubscriptionId;
  if (subscriptionId === null || subscriptionId === undefined) return; // no Stripe subscription → nothing to meter

  const recordId = await stripeClient.recordUsage({
    subscriptionId,
    quantity,
    idempotencyKey: `case:${caseId}`,
  });
  if (recordId === null) return; // billing unavailable / failed (logged)

  const month = monthKey();
  await db.update(usage)
    .set({ stripeUsageRecordId: recordId, reportedToStripeAt: new Date(), updatedAt: new Date() })
    .where(and(eq(usage.tenantId, tenantId), eq(usage.month, month)));
  log.info({ tenantId, caseId, recordId }, "usage reported to Stripe");
}

export async function getUsageSummary(tenantId: string): Promise<UsageSummary> {
  const month = monthKey();
  const rows = await db.select().from(usage).where(and(eq(usage.tenantId, tenantId), eq(usage.month, month))).limit(1);
  const row = rows[0];
  const casesProcessed = row?.casesProcessed ?? 0;
  return { tenantId, month, casesProcessed, apiCalls: row?.apiCalls ?? 0, manualCostAvoidedEur: casesProcessed * 380, timeSavedHours: casesProcessed * (210 - 14) / 60 };
}
