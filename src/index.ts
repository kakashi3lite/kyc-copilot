import { serve } from "@hono/node-server";
import { createApp } from "./api/index.js";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { closeInfrastructure } from "./db/index.js";
import {
  closeGraphResources,
  startGraphWorker,
} from "./workers/graph-runner.js";

const app = createApp();
const worker = startGraphWorker();
const server = serve({ fetch: app.fetch, port: env.PORT }, () => {
  logger.info({ port: env.PORT }, "kyc-copilot started");
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "graceful shutdown initiated");
  try {
    // 1. Stop Hono HTTP server from accepting new requests
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          logger.error({ error: err.message }, "error closing HTTP server");
          reject(err);
        } else {
          logger.info("HTTP server closed successfully");
          resolve();
        }
      });
    });
  } catch (err) {
    // Continue cleanup even if server closing fails
  }

  try {
    // 2. Gracefully close BullMQ worker (stops fetching new jobs, finishes active ones)
    logger.info("closing BullMQ worker...");
    await worker.close();
    logger.info("BullMQ worker closed");
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : String(err) }, "error closing BullMQ worker");
  }

  try {
    // 3. Close graph and database resources
    logger.info("closing graph and database resources...");
    await closeGraphResources();
    await closeInfrastructure();
    logger.info("all infrastructure connections closed");
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : String(err) }, "error closing infrastructure connections");
  }

  (logger as { flush?: () => void }).flush?.();
  process.exit(0);
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

