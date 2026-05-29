import { serve } from "@hono/node-server";
import { createApp } from "./api/index.js";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { closeInfrastructure } from "./db/index.js";
import { startGraphWorker } from "./workers/graph-runner.js";

const app = createApp();
const worker = startGraphWorker();
const server = serve({ fetch: app.fetch, port: env.PORT }, () => {
  logger.info({ port: env.PORT }, "kyc-copilot started");
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "shutdown requested");
  await worker.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeInfrastructure();
  (logger as { flush?: () => void }).flush?.();
}

process.on("SIGTERM", () => { void shutdown("SIGTERM").then(() => process.exit(0)); });
process.on("SIGINT", () => { void shutdown("SIGINT").then(() => process.exit(0)); });
