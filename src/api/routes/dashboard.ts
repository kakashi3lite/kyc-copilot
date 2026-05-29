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
  return c.json({ metrics: metricsRows, recentCases: recent.map((row) => ({ id: row.id, companyName: row.companyNameMask, status: row.status, riskScore: row.riskScore, createdAt: row.createdAt })) });
});
