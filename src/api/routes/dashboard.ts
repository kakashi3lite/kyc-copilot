import { Hono } from "hono";
import { sql, eq, desc } from "drizzle-orm";
import { db } from "../../db/index.js";
import { cases } from "../../db/schema.js";
import { getAuth } from "../middleware/auth.js";

export const dashboardRoutes = new Hono();

dashboardRoutes.get("/dashboard", async (c) => {
  const auth = getAuth(c);
  const recent = await db.select().from(cases).where(eq(cases.tenantId, auth.tenantId)).orderBy(desc(cases.createdAt)).limit(10);
  const metricsRows = await db.select({ status: cases.status, count: sql<number>`count(*)::int` }).from(cases).where(eq(cases.tenantId, auth.tenantId)).groupBy(cases.status);
  // Real risk breakdown grouped by riskScore so the dashboard can show an
  // honest High Risk count instead of a hardcoded value.
  const riskRows = await db.select({ riskScore: cases.riskScore, count: sql<number>`count(*)::int` }).from(cases).where(eq(cases.tenantId, auth.tenantId)).groupBy(cases.riskScore);
  return c.json({
    metrics: metricsRows,
    riskBreakdown: Object.fromEntries(riskRows.map((row) => [row.riskScore ?? "Pending", row.count])),
    recentCases: recent.map((row) => ({ id: row.id, companyName: row.companyNameMask, status: row.status, riskScore: row.riskScore, createdAt: row.createdAt }))
  });
});
