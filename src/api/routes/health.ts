import { Hono } from "hono";
import { checkDb, checkRedis } from "../../db/index.js";
import { env } from "../../config/env.js";

export const healthRoutes = new Hono();

healthRoutes.get("/health", async (c) => {
  const checks = { db: await checkDb(), redis: await checkRedis(), openai: env.OPENAI_API_KEY.length > 0 };
  return c.json({ status: "ok", checks });
});

healthRoutes.get("/ready", async (c) => {
  const checks = { db: await checkDb(), redis: await checkRedis(), openai: env.OPENAI_API_KEY.length > 0 };
  return c.json({ status: Object.values(checks).every(Boolean) ? "ready" : "degraded", checks }, Object.values(checks).every(Boolean) ? 200 : 503);
});
