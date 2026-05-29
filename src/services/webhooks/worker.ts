import { and, eq, lte } from "drizzle-orm";
import { db } from "../../db/index.js";
import { webhookDeliveries } from "../../db/schema.js";
import { deliverWebhook } from "./dispatcher.js";

const delays = [1000, 4000, 16000] as const;

export async function processPendingWebhooks(): Promise<number> {
  const pending = await db.select().from(webhookDeliveries).where(and(eq(webhookDeliveries.status, "pending"), lte(webhookDeliveries.nextAttemptAt, new Date()))).limit(50);
  for (const delivery of pending) {
    const ok = await deliverWebhook(delivery.id);
    if (!ok) {
      const delay = delays[delivery.attempts] ?? 16000;
      await db.update(webhookDeliveries).set({ nextAttemptAt: new Date(Date.now() + delay), status: delivery.attempts >= 2 ? "failed" : "pending" }).where(eq(webhookDeliveries.id, delivery.id));
    }
  }
  return pending.length;
}
