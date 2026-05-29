import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { webhookDeliveries, webhooks } from "../../db/schema.js";
import { decryptPii, encryptPii } from "../encryption/at-rest.js";
import { newId, newSecret } from "../../utils/id.js";
import type { WebhookEvent } from "../../types/index.js";

export function signWebhook(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export async function registerWebhookEndpoint(tenantId: string, url: string, events: WebhookEvent[]): Promise<{ id: string; secret: string }> {
  const id = newId("wh");
  const secret = newSecret("whsec", 24);
  await db.insert(webhooks).values({ id, tenantId, urlEncrypted: encryptPii(url), urlMask: new URL(url).origin, secretEncrypted: encryptPii(secret), events });
  return { id, secret };
}

export async function enqueueWebhookEvent(tenantId: string, event: WebhookEvent, payload: Record<string, unknown>): Promise<void> {
  const endpoints = await db.select().from(webhooks).where(and(eq(webhooks.tenantId, tenantId), eq(webhooks.active, true)));
  for (const endpoint of endpoints) {
    const events = endpoint.events;
    if (!events.includes(event)) continue;
    await db.insert(webhookDeliveries).values({ id: newId("del"), webhookId: endpoint.id, tenantId, event, payload });
  }
}

export async function deliverWebhook(deliveryId: string): Promise<boolean> {
  const rows = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId)).limit(1);
  const delivery = rows[0];
  if (delivery === undefined) return false;
  const endpoints = await db.select().from(webhooks).where(eq(webhooks.id, delivery.webhookId)).limit(1);
  const endpoint = endpoints[0];
  if (endpoint === undefined) return false;
  const body = JSON.stringify(delivery.payload);
  const response = await fetch(decryptPii(endpoint.urlEncrypted), { method: "POST", headers: { "content-type": "application/json", "x-kyc-signature": signWebhook(decryptPii(endpoint.secretEncrypted), body) }, body, signal: AbortSignal.timeout(10000) });
  await db.update(webhookDeliveries).set({ attempts: delivery.attempts + 1, status: response.ok ? "delivered" : "pending", lastError: response.ok ? null : `HTTP ${response.status}`, updatedAt: new Date() }).where(eq(webhookDeliveries.id, delivery.id));
  return response.ok;
}
