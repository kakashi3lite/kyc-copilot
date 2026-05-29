import { eq, and } from "drizzle-orm";
import { db } from "../../db/index.js";
import { usage } from "../../db/schema.js";
import { monthKey } from "../../utils/date.js";
import { newId } from "../../utils/id.js";

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
