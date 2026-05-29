import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { allowedOrigins } from "../config/env.js";
import { authMiddleware } from "./middleware/auth.js";
import { errorHandler } from "./middleware/error-handler.js";
import { requestIdMiddleware } from "./middleware/request-id.js";
import { rateLimit } from "./middleware/rate-limit.js";
import { healthRoutes } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
import { caseRoutes } from "./routes/cases.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { usageRoutes } from "./routes/usage.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { tenantRoutes } from "./routes/tenants.js";

export function createApp(): Hono {
  const app = new Hono();
  const origins = allowedOrigins();
  app.onError(errorHandler);
  app.use("*", requestIdMiddleware);
  app.use("*", async (c, next) => {
    c.header("X-Frame-Options", "DENY");
    c.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
    c.header("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'");
    await next();
  });
  app.use("*", cors({ origin: (origin) => origins.includes(origin) ? origin : origins[0] ?? "http://localhost:3000" }));
  app.route("/", healthRoutes);
  app.route("/", authRoutes);
  app.get("/", (c) => c.html(readFileSync(resolve(process.cwd(), "public", "landing.html"), "utf8")));
  app.get("/app", (c) => c.html(readFileSync(resolve(process.cwd(), "public", "app.html"), "utf8")));
  app.use("/cases", authMiddleware, rateLimit("api"));
  app.use("/cases/*", authMiddleware, rateLimit("api"));
  app.use("/dashboard", authMiddleware, rateLimit("api"));
  app.use("/usage", authMiddleware, rateLimit("api"));
  app.use("/webhooks", authMiddleware, rateLimit("api"));
  app.use("/webhooks/*", authMiddleware, rateLimit("api"));
  app.use("/tenants", authMiddleware, rateLimit("api"));
  app.use("/tenants/*", authMiddleware, rateLimit("api"));
  app.route("/", caseRoutes);
  app.route("/", dashboardRoutes);
  app.route("/", usageRoutes);
  app.route("/", webhookRoutes);
  app.route("/", tenantRoutes);
  return app;
}
