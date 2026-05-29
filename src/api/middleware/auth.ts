import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import type { Context, Next } from "hono";
import { eq, isNull } from "drizzle-orm";
import { db } from "../../db/index.js";
import { tenants, users } from "../../db/schema.js";
import { env } from "../../config/env.js";
import { problem } from "./error-handler.js";
import type { Plan } from "../../types/index.js";

export interface AuthContext { tenantId: string; userId?: string; role: "admin" | "analyst" | "api"; plan: Plan; }
interface JwtClaims { sub: string; tenantId: string; role: "admin" | "analyst"; type: "access" | "refresh"; }

export function signAccessToken(claims: Omit<JwtClaims, "type">): string {
  return jwt.sign({ ...claims, type: "access" }, env.JWT_SECRET, { expiresIn: "15m" });
}

export function signRefreshToken(claims: Omit<JwtClaims, "type">): string {
  return jwt.sign({ ...claims, type: "refresh" }, env.JWT_REFRESH_SECRET, { expiresIn: "7d" });
}

export async function authMiddleware(c: Context, next: Next): Promise<Response | void> {
  const header = c.req.header("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || token === undefined) return problem(c, 401, "Unauthorized", "Bearer token required");
  if (token.startsWith("kc_live_")) {
    const rows = await db.select().from(tenants).where(isNull(tenants.deletedAt));
    for (const tenant of rows) {
      if (tenant.active && await bcrypt.compare(token, tenant.apiKeyHash)) {
        c.set("auth", { tenantId: tenant.id, role: "api", plan: tenant.plan } satisfies AuthContext);
        await next();
        return;
      }
    }
    return problem(c, 401, "Unauthorized", "Invalid API key");
  }
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as JwtClaims;
    if (decoded.type !== "access") return problem(c, 401, "Unauthorized", "Invalid token type");
    const tenantRows = await db.select().from(tenants).where(eq(tenants.id, decoded.tenantId)).limit(1);
    const tenant = tenantRows[0];
    if (tenant === undefined || !tenant.active) return problem(c, 401, "Unauthorized", "Tenant inactive");
    c.set("auth", { tenantId: decoded.tenantId, userId: decoded.sub, role: decoded.role, plan: tenant.plan } satisfies AuthContext);
    await next();
  } catch {
    return problem(c, 401, "Unauthorized", "Invalid token");
  }
}

export function requireAdmin(c: Context): Response | null {
  const auth = getAuth(c);
  return auth.role === "admin" ? null : problem(c, 403, "Forbidden", "Admin role required");
}

export function getAuth(c: Context): AuthContext {
  return c.get("auth") as AuthContext;
}

export async function findUserByEmail(email: string): Promise<typeof users.$inferSelect | null> {
  const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return rows[0] ?? null;
}
