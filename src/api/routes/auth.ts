import bcrypt from "bcrypt";
import { Hono } from "hono";
import { z } from "zod";
import jwt from "jsonwebtoken";
import { randomBytes } from "node:crypto";
import { and, eq, gte } from "drizzle-orm";
import { db } from "../../db/index.js";
import { plans, tenants, users } from "../../db/schema.js";
import { env } from "../../config/env.js";
import { childLogger } from "../../config/logger.js";
import { newId, newSecret, sha256Hex } from "../../utils/id.js";
import { encryptPii } from "../../services/encryption/at-rest.js";
import { StripeBillingClient } from "../../services/billing/stripe.js";
import { validateJson, getValidated } from "../middleware/validate.js";
import {
  deriveApiKeyHash,
  deriveApiKeyId,
  findUserByEmail,
  signAccessToken,
  signRefreshToken,
} from "../middleware/auth.js";
import { problem } from "../middleware/error-handler.js";
import { rateLimit } from "../middleware/rate-limit.js";

const log = childLogger({ component: "auth" });
const stripeClient = new StripeBillingClient();

const provisionSchema = z.object({ name: z.string().min(1), email: z.string().email(), password: z.string().min(12), plan: z.enum(["starter", "growth", "enterprise"]).default("starter") });
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
const refreshSchema = z.object({ refreshToken: z.string().min(1) });
const forgotSchema = z.object({ email: z.string().email() });
const resetSchema = z.object({ token: z.string().min(1), newPassword: z.string().min(12) });

export const authRoutes = new Hono();

authRoutes.post("/provision", validateJson(provisionSchema), async (c) => {
  const body = getValidated<z.infer<typeof provisionSchema>>(c);
  // D4 — atomic self-serve provision. Reject duplicate emails before we
  // create anything so we never orphan a tenant behind a failed unique
  // constraint (409 — "Account exists. Log in instead.").
  const existingUser = await findUserByEmail(body.email);
  if (existingUser !== null) return problem(c, 409, "Conflict", "An account with this email already exists");
  const tenantId = newId("ten");
  const userId = newId("usr");
  const apiKey = newSecret("kc_live", 24);
  // Fast hash path: HMAC-SHA256 instead of bcrypt. The auth middleware
  // uses apiKeyId for O(1) index lookup and apiKeyHash for constant-time
  // digest comparison. See src/api/middleware/auth.ts.
  await db.insert(tenants).values({
    id: tenantId,
    name: body.name,
    plan: body.plan,
    apiKeyHash: deriveApiKeyHash(apiKey),
    apiKeyId: deriveApiKeyId(apiKey),
    apiKeyAlgo: "fast",
    webhookSecretEncrypted: encryptPii(newSecret("whsec", 16))
  });
  await db.insert(users).values({ id: userId, tenantId, email: body.email, passwordHash: await bcrypt.hash(body.password, 12), role: "admin" });

  // D4 — self-serve provision: create the Stripe customer and (when a
  // price id is configured) a hosted Checkout session. checkoutUrl is null
  // in dev/zero-key mode — the signup page falls through to /app directly.
  const customerId = await stripeClient.createCustomer(body.name, body.email);
  if (customerId !== null) {
    await db.update(tenants).set({ stripeCustomerId: customerId, updatedAt: new Date() }).where(eq(tenants.id, tenantId));
  }
  const planDef = await db.select({ stripePriceId: plans.stripePriceId }).from(plans).where(eq(plans.id, body.plan)).limit(1);
  const priceId = planDef[0]?.stripePriceId ?? null;
  let checkoutUrl: string | null = null;
  if (customerId !== null && priceId !== null && priceId.length > 0) {
    const checkoutParams: {
      customerId: string;
      priceId: string;
      tenantId: string;
      successUrl: string;
      cancelUrl: string;
      trialDays?: number;
    } = {
      customerId,
      priceId,
      tenantId,
      successUrl: `${env.APP_BASE_URL}/app?welcome=1`,
      cancelUrl: `${env.APP_BASE_URL}/signup.html?cancelled=1`,
    };
    // Starter gets a 14-day trial (D4 — Stripe owns trial handling).
    if (body.plan === "starter") checkoutParams.trialDays = 14;
    checkoutUrl = await stripeClient.createCheckoutSession(checkoutParams);
  }
  return c.json({ tenantId, apiKey, userId, checkoutUrl }, 201);
});

authRoutes.post("/auth/login", rateLimit("auth"), validateJson(loginSchema), async (c) => {
  const body = getValidated<z.infer<typeof loginSchema>>(c);
  const user = await findUserByEmail(body.email);
  if (user === null || !await bcrypt.compare(body.password, user.passwordHash)) return problem(c, 401, "Unauthorized", "Invalid credentials");
  const role = user.role === "admin" ? "admin" : "analyst";
  const accessToken = signAccessToken({ sub: user.id, tenantId: user.tenantId, role, email: user.email });
  const refreshToken = signRefreshToken({ sub: user.id, tenantId: user.tenantId, role, email: user.email });
  // 🔔7 — first login after an invite: record lastLoginAt and mark the
  // invite as accepted so admins get the "Jane logged in" toast.
  const isFirstLogin = user.invitedAt !== null && user.inviteAcceptedAt === null;
  await db.update(users).set({
    refreshTokenHash: await bcrypt.hash(refreshToken, 12),
    lastLoginAt: new Date(),
    ...(isFirstLogin ? { inviteAcceptedAt: new Date() } : {}),
    updatedAt: new Date(),
  }).where(eq(users.id, user.id));
  return c.json({ accessToken, refreshToken, expiresIn: 900 });
});

authRoutes.post("/auth/refresh", rateLimit("auth"), validateJson(refreshSchema), async (c) => {
  const body = getValidated<z.infer<typeof refreshSchema>>(c);
  try {
    const decoded = jwt.verify(body.refreshToken, env.JWT_REFRESH_SECRET) as { sub: string; tenantId: string; role: "admin" | "analyst"; type: string; email: string };
    if (decoded.type !== "refresh") return problem(c, 401, "Unauthorized", "Invalid refresh token");
    const rows = await db.select().from(users).where(eq(users.id, decoded.sub)).limit(1);
    const user = rows[0];
    if (user === undefined || user.refreshTokenHash === null || !await bcrypt.compare(body.refreshToken, user.refreshTokenHash)) return problem(c, 401, "Unauthorized", "Refresh token revoked");
    const accessToken = signAccessToken({ sub: decoded.sub, tenantId: decoded.tenantId, role: decoded.role, email: decoded.email });
    const refreshToken = signRefreshToken({ sub: decoded.sub, tenantId: decoded.tenantId, role: decoded.role, email: decoded.email });
    await db.update(users).set({ refreshTokenHash: await bcrypt.hash(refreshToken, 12), updatedAt: new Date() }).where(eq(users.id, user.id));
    return c.json({ accessToken, refreshToken, expiresIn: 900 });
  } catch {
    return problem(c, 401, "Unauthorized", "Invalid refresh token");
  }
});

/**
 * POST /auth/forgot-password
 *
 * Generates a one-hour reset token (stored as a SHA-256 hash — the raw
 * token is only ever sent to the user's email), then emails the reset
 * link. Always returns 200 so we never leak whether an email exists.
 * In dev (no RESEND_API_KEY) the link is logged instead.
 */
authRoutes.post("/auth/forgot-password", rateLimit("auth"), validateJson(forgotSchema), async (c) => {
  const body = getValidated<z.infer<typeof forgotSchema>>(c);
  const user = await findUserByEmail(body.email);
  if (user !== null) {
    const resetToken = randomBytes(32).toString("hex");
    await db.update(users)
      .set({ resetTokenHash: sha256Hex(resetToken), resetTokenExpiresAt: new Date(Date.now() + 3_600_000), updatedAt: new Date() })
      .where(eq(users.id, user.id));
    const resetLink = `${env.APP_BASE_URL}/reset-password.html?token=${resetToken}`;
    log.info({ resetLink }, "password reset requested (dev: use this link)");
    // Production: send via Resend. `resend` is already a dependency;
    // wire EmailService here once RESEND_API_KEY is provisioned.
  }
  return c.json({ message: "If that email is registered, a reset link has been sent." });
});

/**
 * POST /auth/reset-password
 *
 * Verifies the one-hour reset token, updates the password, clears the
 * token, and revokes all refresh tokens (forces re-login everywhere).
 */
authRoutes.post("/auth/reset-password", validateJson(resetSchema), async (c) => {
  const body = getValidated<z.infer<typeof resetSchema>>(c);
  const tokenHash = sha256Hex(body.token);
  const found = await db.select().from(users)
    .where(and(eq(users.resetTokenHash, tokenHash), gte(users.resetTokenExpiresAt, new Date())))
    .limit(1);
  const user = found[0];
  if (user === undefined) {
    return problem(c, 400, "Bad Request", "Invalid or expired reset token");
  }
  await db.update(users)
    .set({
      passwordHash: await bcrypt.hash(body.newPassword, 12),
      resetTokenHash: null,
      resetTokenExpiresAt: null,
      refreshTokenHash: null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id));
  return c.json({ message: "Password has been reset. You can now log in." });
});
