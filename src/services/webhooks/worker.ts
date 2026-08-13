import { and, eq, lte } from "drizzle-orm";
import { db } from "../../db/index.js";
import { webhookDeliveries } from "../../db/schema.js";
import { deliverWebhook } from "./dispatcher.js";

/** Total delivery attempts (1 initial + 2 retries) before dead-lettering. */
export const MAX_ATTEMPTS = 3;

const delays = [1000, 4000, 16000] as const;

export async function processPendingWebhooks(): Promise<number> {
  const pending = await db.select().from(webhookDeliveries).where(and(eq(webhookDeliveries.status, "pending"), lte(webhookDeliveries.nextAttemptAt, new Date()))).limit(50);
  for (const delivery of pending) {
    const ok = await deliverWebhook(delivery.id);
    if (!ok) {
      const attempts = delivery.attempts + 1; // the attempt that just completed
      const terminal = attempts >= MAX_ATTEMPTS;
      const delay = delays[delivery.attempts] ?? 16000;
      await db.update(webhookDeliveries).set({
        status: terminal ? "failed" : "pending",
        failedAt: terminal ? new Date() : null,
        nextAttemptAt: terminal ? undefined : new Date(Date.now() + delay),
        updatedAt: new Date(),
      }).where(eq(webhookDeliveries.id, delivery.id));
    }
  }
  return pending.length;
}
