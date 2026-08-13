import { Hono } from "hono";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { webhookDeliveries, webhooks } from "../../db/schema.js";
import { registerWebhookEndpoint, enqueueWebhookEvent } from "../../services/webhooks/dispatcher.js";
import { replayAllForWebhook, replayDelivery } from "../../services/webhooks/replay.js";
import { validateJson, getValidated } from "../middleware/validate.js";
import { getAuth, type AuthContext } from "../middleware/auth.js";
import { problem } from "../middleware/error-handler.js";

const webhookSchema = z.object({ url: z.string().url(), events: z.array(z.enum(["case.created", "case.completed", "case.pending_hitl", "case.failed", "case.approved", "webhook.test"])) });

function planGate(c: Parameters<typeof problem>[0], auth: AuthContext): Response | null {
  if (auth.plan === "starter") return problem(c, 403, "Forbidden", "Webhooks require Growth plan");
  return null;
}

export const webhookRoutes = new Hono();

webhookRoutes.post("/webhooks", validateJson(webhookSchema), async (c) => {
  const auth = getAuth(c);
  const gate = planGate(c, auth);
  if (gate) return gate;
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
  const gate = planGate(c, auth);
  if (gate) return gate;
  await enqueueWebhookEvent(auth.tenantId, "webhook.test", { webhookId: c.req.param("id"), ok: true });
  return c.json({ queued: true });
});

// ── Delivery history + replay (DLQ, ADR-022) ───────────────────────────────

webhookRoutes.get("/webhooks/:id/deliveries", async (c) => {
  const auth = getAuth(c);
  const gate = planGate(c, auth);
  if (gate) return gate;

  const webhookId = c.req.param("id");
  const owner = await db.select({ id: webhooks.id }).from(webhooks).where(and(eq(webhooks.id, webhookId), eq(webhooks.tenantId, auth.tenantId))).limit(1);
  if (owner[0] === undefined) return problem(c, 404, "Not Found", "Webhook not found");

  const status = c.req.query("status");
  const rawLimit = Number(c.req.query("limit") ?? "50");
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 50, 1), 100);
  const where = and(
    eq(webhookDeliveries.webhookId, webhookId),
    eq(webhookDeliveries.tenantId, auth.tenantId),
    status ? eq(webhookDeliveries.status, status) : undefined,
  );
  const rows = await db.select().from(webhookDeliveries).where(where).orderBy(desc(webhookDeliveries.createdAt)).limit(limit);
  return c.json({
    deliveries: rows.map((d) => ({
      id: d.id,
      event: d.event,
      status: d.status,
      attempts: d.attempts,
      lastError: d.lastError,
      lastHttpStatus: d.lastHttpStatus,
      failedAt: d.failedAt,
      nextAttemptAt: d.nextAttemptAt,
      createdAt: d.createdAt,
    })),
  });
});

webhookRoutes.post("/webhooks/:id/deliveries/:deliveryId/replay", async (c) => {
  const auth = getAuth(c);
  const gate = planGate(c, auth);
  if (gate) return gate;

  const result = await replayDelivery(c.req.param("deliveryId"), auth.tenantId);
  if (result === "missing") return problem(c, 404, "Not Found", "Delivery not found");
  if (result === "not_failed") return problem(c, 409, "Conflict", "Only failed deliveries can be replayed");
  return c.json({ replayed: 1 }, 202);
});

webhookRoutes.post("/webhooks/:id/replay", async (c) => {
  const auth = getAuth(c);
  const gate = planGate(c, auth);
  if (gate) return gate;

  const result = await replayAllForWebhook(c.req.param("id"), auth.tenantId);
  if (result === null) return problem(c, 404, "Not Found", "Webhook not found");
  return c.json({ replayed: result.replayed, skipped: result.skipped }, 202);
});
