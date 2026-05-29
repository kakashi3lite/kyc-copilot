import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { usage } from "../../db/schema.js";
import { monthKey } from "../../utils/date.js";
import { newId } from "../../utils/id.js";

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

export async function getUsageSummary(tenantId: string): Promise<UsageSummary> {
  const month = monthKey();
  const rows = await db.select().from(usage).where(and(eq(usage.tenantId, tenantId), eq(usage.month, month))).limit(1);
  const row = rows[0];
  const casesProcessed = row?.casesProcessed ?? 0;
  return { tenantId, month, casesProcessed, apiCalls: row?.apiCalls ?? 0, manualCostAvoidedEur: casesProcessed * 380, timeSavedHours: casesProcessed * (210 - 14) / 60 };
}
