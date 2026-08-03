import { Hono } from "hono";
import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "../../db/index.js";
import { usage } from "../../db/schema.js";
import { getUsageSummary } from "../../services/billing/usage-meter.js";
import { getAuth } from "../middleware/auth.js";
import { monthsAgoKey } from "../../utils/date.js";

export const usageRoutes = new Hono();

usageRoutes.get("/usage", async (c) => {
  const auth = getAuth(c);
  const summary = await getUsageSummary(auth.tenantId);

  // Real 6-month history: query the usage table and fill zero rows for
  // months with no recorded activity so the chart never has holes.
  const startMonth = monthsAgoKey(5);
  const rows = await db
    .select({
      month: usage.month,
      casesProcessed: usage.casesProcessed,
      apiCalls: usage.apiCalls,
      costUsd: usage.costUsd,
    })
    .from(usage)
    .where(and(eq(usage.tenantId, auth.tenantId), gte(usage.month, startMonth)))
    .orderBy(desc(usage.month))
    .limit(6);

  const byMonth = new Map(rows.map((r) => [r.month, r]));
  const sixMonthHistory = Array.from({ length: 6 }, (_, i) => {
    const month = monthsAgoKey(5 - i);
    const row = byMonth.get(month);
    return {
      month,
      casesProcessed: row?.casesProcessed ?? 0,
      apiCalls: row?.apiCalls ?? 0,
      costUsd: row !== undefined ? Number(row.costUsd) : 0,
    };
  });

  return c.json({ ...summary, sixMonthHistory });
});
