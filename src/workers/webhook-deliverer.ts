import { Worker } from "bullmq";
import { redis } from "../db/index.js";
import { processPendingWebhooks } from "../services/webhooks/worker.js";

export function startWebhookDeliverer(): Worker<Record<string, never>> {
  return new Worker<Record<string, never>>("webhook-deliverer", async () => { await processPendingWebhooks(); }, { connection: redis, concurrency: 3 });
}
