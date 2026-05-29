import bcrypt from "bcrypt";
import { Hono } from "hono";
import { z } from "zod";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { tenants, users } from "../../db/schema.js";
import { env } from "../../config/env.js";
import { newId, newSecret } from "../../utils/id.js";
import { encryptPii } from "../../services/encryption/at-rest.js";
import { validateJson, getValidated } from "../middleware/validate.js";
import { findUserByEmail, signAccessToken, signRefreshToken } from "../middleware/auth.js";
import { problem } from "../middleware/error-handler.js";
import { rateLimit } from "../middleware/rate-limit.js";

const provisionSchema = z.object({ name: z.string().min(1), email: z.string().email(), password: z.string().min(12), plan: z.enum(["starter", "growth", "enterprise"]).default("starter") });
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
const refreshSchema = z.object({ refreshToken: z.string().min(1) });

export const authRoutes = new Hono();

authRoutes.post("/provision", validateJson(provisionSchema), async (c) => {
  const body = getValidated<z.infer<typeof provisionSchema>>(c);
  const tenantId = newId("ten");
  const userId = newId("usr");
  const apiKey = newSecret("kc_live", 24);
  await db.insert(tenants).values({ id: tenantId, name: body.name, plan: body.plan, apiKeyHash: await bcrypt.hash(apiKey, 12), webhookSecretEncrypted: encryptPii(newSecret("whsec", 16)) });
  await db.insert(users).values({ id: userId, tenantId, email: body.email, passwordHash: await bcrypt.hash(body.password, 12), role: "admin" });
  return c.json({ tenantId, apiKey, userId }, 201);
});

authRoutes.post("/auth/login", rateLimit("auth"), validateJson(loginSchema), async (c) => {
  const body = getValidated<z.infer<typeof loginSchema>>(c);
  const user = await findUserByEmail(body.email);
  if (user === null || !await bcrypt.compare(body.password, user.passwordHash)) return problem(c, 401, "Unauthorized", "Invalid credentials");
  const role = user.role === "admin" ? "admin" : "analyst";
  const accessToken = signAccessToken({ sub: user.id, tenantId: user.tenantId, role });
  const refreshToken = signRefreshToken({ sub: user.id, tenantId: user.tenantId, role });
  await db.update(users).set({ refreshTokenHash: await bcrypt.hash(refreshToken, 12), updatedAt: new Date() }).where(eq(users.id, user.id));
  return c.json({ accessToken, refreshToken, expiresIn: 900 });
});

authRoutes.post("/auth/refresh", rateLimit("auth"), validateJson(refreshSchema), async (c) => {
  const body = getValidated<z.infer<typeof refreshSchema>>(c);
  try {
    const decoded = jwt.verify(body.refreshToken, env.JWT_REFRESH_SECRET) as { sub: string; tenantId: string; role: "admin" | "analyst"; type: string };
    if (decoded.type !== "refresh") return problem(c, 401, "Unauthorized", "Invalid refresh token");
    const rows = await db.select().from(users).where(eq(users.id, decoded.sub)).limit(1);
    const user = rows[0];
    if (user === undefined || user.refreshTokenHash === null || !await bcrypt.compare(body.refreshToken, user.refreshTokenHash)) return problem(c, 401, "Unauthorized", "Refresh token revoked");
    const accessToken = signAccessToken({ sub: decoded.sub, tenantId: decoded.tenantId, role: decoded.role });
    const refreshToken = signRefreshToken({ sub: decoded.sub, tenantId: decoded.tenantId, role: decoded.role });
    await db.update(users).set({ refreshTokenHash: await bcrypt.hash(refreshToken, 12), updatedAt: new Date() }).where(eq(users.id, user.id));
    return c.json({ accessToken, refreshToken, expiresIn: 900 });
  } catch {
    return problem(c, 401, "Unauthorized", "Invalid refresh token");
  }
});
