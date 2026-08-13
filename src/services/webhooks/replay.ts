/**
 * Webhook dead-letter recovery — Phase 4 (ADR-022).
 *
 * Failed deliveries are terminal (DLQ) but recoverable: replay is a
 * STATUS RESET, never a re-run. The original `payload` is kept and reused
 * (no re-fetch from the case — no new decryption). A `delivered` delivery
 * is never replayed.
 */

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { webhookDeliveries, webhooks } from "../../db/schema.js";
import { enqueueDeliveryTrigger } from "./dispatcher.js";

export type ReplayResult = "replayed" | "not_failed" | "missing";

export async function replayDelivery(deliveryId: string, tenantId: string): Promise<ReplayResult> {
  const rows = await db
    .select({ id: webhookDeliveries.id, status: webhookDeliveries.status })
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.tenantId, tenantId)))
    .limit(1);
  const delivery = rows[0];
  if (delivery === undefined) return "missing";
  if (delivery.status !== "failed") return "not_failed";

  await db.update(webhookDeliveries)
    .set({ status: "pending", attempts: 0, nextAttemptAt: new Date(), failedAt: null, updatedAt: new Date() })
    .where(eq(webhookDeliveries.id, deliveryId));
  await enqueueDeliveryTrigger();
  return "replayed";
}

/** Replay every failed delivery for a webhook. Returns null when the webhook is missing/foreign. */
export async function replayAllForWebhook(
  webhookId: string,
  tenantId: string,
): Promise<{ replayed: number; skipped: number } | null> {
  const owner = await db
    .select({ id: webhooks.id })
    .from(webhooks)
    .where(and(eq(webhooks.id, webhookId), eq(webhooks.tenantId, tenantId)))
    .limit(1);
  if (owner[0] === undefined) return null;

  const all = await db
    .select({ id: webhookDeliveries.id, status: webhookDeliveries.status })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.webhookId, webhookId));
  const failedIds = all.filter((d) => d.status === "failed").map((d) => d.id);
  if (failedIds.length === 0) return { replayed: 0, skipped: all.length };

  await db.update(webhookDeliveries)
    .set({ status: "pending", attempts: 0, nextAttemptAt: new Date(), failedAt: null, updatedAt: new Date() })
    .where(and(inArray(webhookDeliveries.id, failedIds), eq(webhookDeliveries.tenantId, tenantId)));
  await enqueueDeliveryTrigger();
  return { replayed: failedIds.length, skipped: all.length - failedIds.length };
}
