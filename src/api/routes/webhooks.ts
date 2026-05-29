import { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { webhooks } from "../../db/schema.js";
import { registerWebhookEndpoint, enqueueWebhookEvent } from "../../services/webhooks/dispatcher.js";
import { validateJson, getValidated } from "../middleware/validate.js";
import { getAuth } from "../middleware/auth.js";
import { problem } from "../middleware/error-handler.js";

const webhookSchema = z.object({ url: z.string().url(), events: z.array(z.enum(["case.created", "case.completed", "case.pending_hitl", "case.failed", "case.approved", "webhook.test"])) });

export const webhookRoutes = new Hono();

webhookRoutes.post("/webhooks", validateJson(webhookSchema), async (c) => {
  const auth = getAuth(c);
  if (auth.plan === "starter") return problem(c, 403, "Forbidden", "Webhooks require Growth plan");
  const body = getValidated<z.infer<typeof webhookSchema>>(c);
  const result = await registerWebhookEndpoint(auth.tenantId, body.url, body.events);
  return c.json(result, 201);
});

webhookRoutes.get("/webhooks", async (c) => {
  const auth = getAuth(c);
  const rows = await db.select().from(webhooks).where(eq(webhooks.tenantId, auth.tenantId));
  return c.json({ webhooks: rows.map((row) => ({ id: row.id, url: row.urlMask, events: row.events, active: row.active, createdAt: row.createdAt })) });
});

webhookRoutes.post("/webhooks/:id/test", async (c) => {
  const auth = getAuth(c);
  await enqueueWebhookEvent(auth.tenantId, "webhook.test", { webhookId: c.req.param("id"), ok: true });
  return c.json({ queued: true });
});
