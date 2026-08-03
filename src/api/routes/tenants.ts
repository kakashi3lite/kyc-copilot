import { Hono } from "hono";
import { and, desc, eq, gte } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/index.js";
import { tenants, usage } from "../../db/schema.js";
import { requireAdmin } from "../middleware/auth.js";
import { validateJson, getValidated } from "../middleware/validate.js";
import { monthsAgoKey } from "../../utils/date.js";

const planSchema = z.object({ plan: z.enum(["starter", "growth", "enterprise"]) });

export const tenantRoutes = new Hono();

tenantRoutes.get("/tenants", async (c) => {
  const denied = requireAdmin(c);
  if (denied !== null) return denied;
  const rows = await db.select({ id: tenants.id, name: tenants.name, plan: tenants.plan, active: tenants.active, createdAt: tenants.createdAt }).from(tenants);
  return c.json({ tenants: rows });
});

tenantRoutes.get("/tenants/:id/usage", async (c) => {
  const denied = requireAdmin(c);
  if (denied !== null) return denied;
  const tenantId = c.req.param("id") ?? "";
  // Real 6-month usage history (R12 — was a hardcoded empty array).
  const rows = await db
    .select({ month: usage.month, casesProcessed: usage.casesProcessed, apiCalls: usage.apiCalls, costUsd: usage.costUsd })
    .from(usage)
    .where(and(eq(usage.tenantId, tenantId), gte(usage.month, monthsAgoKey(5))))
    .orderBy(desc(usage.month))
    .limit(6);
  return c.json({ tenantId, usage: rows });
});

tenantRoutes.post("/tenants/:id/plan", validateJson(planSchema), async (c) => {
  const denied = requireAdmin(c);
  if (denied !== null) return denied;
  const body = getValidated<z.infer<typeof planSchema>>(c);
  const tenantId = c.req.param("id") ?? "";
  await db.update(tenants).set({ plan: body.plan, updatedAt: new Date() }).where(eq(tenants.id, tenantId));
  return c.json({ tenantId, plan: body.plan });
});
