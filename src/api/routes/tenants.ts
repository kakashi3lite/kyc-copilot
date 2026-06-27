import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/index.js";
import { tenants } from "../../db/schema.js";
import { requireAdmin } from "../middleware/auth.js";
import { validateJson, getValidated } from "../middleware/validate.js";

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
  return c.json({ tenantId: c.req.param("id"), usage: [] });
});

tenantRoutes.post("/tenants/:id/plan", validateJson(planSchema), async (c) => {
  const denied = requireAdmin(c);
  if (denied !== null) return denied;
  const body = getValidated<z.infer<typeof planSchema>>(c);
  const tenantId = c.req.param("id") ?? "";
  await db.update(tenants).set({ plan: body.plan, updatedAt: new Date() }).where(eq(tenants.id, tenantId));
  return c.json({ tenantId, plan: body.plan });
});
