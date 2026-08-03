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
import { billingRoutes } from "./routes/billing.js";
import { stripeWebhookRoutes } from "./routes/stripe-webhook.js";
import { userRoutes } from "./routes/users.js";

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
  // Stripe webhook is PUBLIC and must see the RAW body — register it before
  // any body-consuming middleware so `c.req.text()` returns the untouched
  // payload for signature verification.
  app.route("/", stripeWebhookRoutes);
  app.route("/", healthRoutes);
  app.route("/", authRoutes);
  app.get("/", (c) => c.html(readFileSync(resolve(process.cwd(), "public", "landing.html"), "utf8")));
  app.get("/app", (c) => c.html(readFileSync(resolve(process.cwd(), "public", "app.html"), "utf8")));
  app.get("/login", (c) => c.html(readFileSync(resolve(process.cwd(), "public", "login.html"), "utf8")));
  app.get("/signup", (c) => c.html(readFileSync(resolve(process.cwd(), "public", "signup.html"), "utf8")));
  app.get("/login.html", (c) => c.html(readFileSync(resolve(process.cwd(), "public", "login.html"), "utf8")));
  app.get("/signup.html", (c) => c.html(readFileSync(resolve(process.cwd(), "public", "signup.html"), "utf8")));
  app.get("/forgot-password.html", (c) => c.html(readFileSync(resolve(process.cwd(), "public", "forgot-password.html"), "utf8")));
  app.get("/reset-password.html", (c) => c.html(readFileSync(resolve(process.cwd(), "public", "reset-password.html"), "utf8")));
  // Crawler policy — blocks auth/dashboard routes from SEO indexers.
  app.get("/robots.txt", (c) => c.text(readFileSync(resolve(process.cwd(), "public", "robots.txt"), "utf8")));
  app.use("/cases", authMiddleware, rateLimit("api"));
  app.use("/cases/*", authMiddleware, rateLimit("api"));
  app.use("/dashboard", authMiddleware, rateLimit("api"));
  app.use("/usage", authMiddleware, rateLimit("api"));
  app.use("/webhooks", authMiddleware, rateLimit("api"));
  app.use("/webhooks/*", authMiddleware, rateLimit("api"));
  app.use("/tenants", authMiddleware, rateLimit("api"));
  app.use("/tenants/*", authMiddleware, rateLimit("api"));
  app.use("/billing", authMiddleware, rateLimit("api"));
  app.use("/billing/*", authMiddleware, rateLimit("api"));
  app.use("/users", authMiddleware, rateLimit("api"));
  app.use("/users/*", authMiddleware, rateLimit("api"));
  app.route("/", caseRoutes);
  app.route("/", dashboardRoutes);
  app.route("/", usageRoutes);
  app.route("/", webhookRoutes);
  app.route("/", tenantRoutes);
  app.route("/", billingRoutes);
  app.route("/", userRoutes);
  return app;
}
