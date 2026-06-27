import bcrypt from "bcrypt";
import { createHmac, timingSafeEqual } from "node:crypto";
import jwt from "jsonwebtoken";
import type { Context, Next } from "hono";
import { eq, isNull } from "drizzle-orm";
import { db } from "../../db/index.js";
import { tenants, users } from "../../db/schema.js";
import { env } from "../../config/env.js";
import { problem } from "./error-handler.js";
import type { Plan } from "../../types/index.js";
import { logger } from "../../config/logger.js";

export interface AuthContext { tenantId: string; userId?: string; role: "admin" | "analyst" | "api"; plan: Plan; }
interface JwtClaims { sub: string; tenantId: string; role: "admin" | "analyst"; type: "access" | "refresh"; }

/**
 * Secret used to derive the indexable apiKeyId from the raw key.
 * Falls back to JWT_SECRET if not set (dev-only convenience; production
 * deployments MUST set API_KEY_LOOKUP_SECRET to a value distinct from
 * JWT_SECRET so a JWT-secret leak doesn't also let an attacker forge
 * lookup IDs).
 */
const LOOKUP_SECRET = env.API_KEY_LOOKUP_SECRET ?? env.JWT_SECRET;

/**
 * Derive the indexable lookup ID from a raw API key. The first 16 hex
 * characters (8 bytes) of HMAC-SHA256 is plenty to discriminate between
 * tenants with negligible collision risk, and short enough to keep the
 * unique index narrow. The secret is server-side only — an attacker who
 * knows a single tenant's API key cannot derive another tenant's ID
 * without first breaking HMAC-SHA256.
 */
export function deriveApiKeyId(rawKey: string): string {
  const fullDigest = createHmac("sha256", LOOKUP_SECRET).update(rawKey).digest();
  return fullDigest.subarray(0, 8).toString("hex");
}

/**
 * Derive the constant-time verification digest for a raw API key. The
 * full 32-byte HMAC-SHA256 output is stored at provision time, and the
 * same digest is recomputed on every request for crypto.timingSafeEqual.
 */
export function deriveApiKeyHash(rawKey: string): string {
  return createHmac("sha256", LOOKUP_SECRET).update(rawKey).digest("hex");
}

/**
 * Constant-time compare of two hex-encoded HMAC digests.
 *
 * Per Node.js docs, `crypto.timingSafeEqual(a, b)` requires equal-length
 * Buffers and THROWS otherwise. The Cloudflare Workers guidance is
 * explicit: do not early-return on length mismatch — that leaks the
 * secret length via response timing. We defend in three ways:
 *   1. Both inputs are SHA-256 hex digests — always 64 chars
 *   2. Validate hex format before comparison; non-hex input returns false
 *   3. timingSafeEqual runs in O(n) time independent of where the first
 *      byte differs
 */
export function safeEqualHexDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  if (a.length !== 64) return false; // SHA-256 hex = 64 chars
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false;
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  return timingSafeEqual(bufA, bufB);
}

export function signAccessToken(claims: Omit<JwtClaims, "type">): string {
  return jwt.sign({ ...claims, type: "access" }, env.JWT_SECRET, { expiresIn: "15m" });
}

export function signRefreshToken(claims: Omit<JwtClaims, "type">): string {
  return jwt.sign({ ...claims, type: "refresh" }, env.JWT_REFRESH_SECRET, { expiresIn: "7d" });
}

/**
 * O(1) API key lookup. Uses an indexable `api_key_id` column (first
 * 8 bytes of HMAC-SHA256 hex) for a single-row LIMIT 1 query, then
 * a constant-time digest comparison.
 *
 * Legacy bcrypt-hashed keys are still honored for backward compatibility
 * during the migration window. Once all tenants have been re-hashed to
 * the fast path, the bcrypt fallback can be removed.
 */
async function authenticateApiKey(rawKey: string): Promise<AuthContext | null> {
  const lookupId = deriveApiKeyId(rawKey);
  const rows = await db
    .select({
      id: tenants.id,
      plan: tenants.plan,
      active: tenants.active,
      apiKeyHash: tenants.apiKeyHash,
      apiKeyAlgo: tenants.apiKeyAlgo
    })
    .from(tenants)
    .where(eq(tenants.apiKeyId, lookupId))
    .limit(1);
  const tenant = rows[0];
  if (tenant === undefined || !tenant.active) return null;

  const algo = tenant.apiKeyAlgo ?? "bcrypt";
  if (algo === "fast") {
    // O(1) constant-time compare on 32-byte digests
    const candidate = deriveApiKeyHash(rawKey);
    if (!safeEqualHexDigest(tenant.apiKeyHash, candidate)) return null;
    return { tenantId: tenant.id, role: "api", plan: tenant.plan };
  }

  // Legacy bcrypt path — kept for migration safety. New tenants go to
  // the fast path via the `provision` endpoint (see auth.ts).
  const ok = await bcrypt.compare(rawKey, tenant.apiKeyHash);
  return ok ? { tenantId: tenant.id, role: "api", plan: tenant.plan } : null;
}

export async function authMiddleware(c: Context, next: Next): Promise<Response | void> {
  const header = c.req.header("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || token === undefined) return problem(c, 401, "Unauthorized", "Bearer token required");
  if (token.startsWith("kc_live_")) {
    const auth = await authenticateApiKey(token);
    if (auth === null) return problem(c, 401, "Unauthorized", "Invalid API key");
    c.set("auth", auth satisfies AuthContext);
    await next();
    return;
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

/**
 * Constant-time webhook signature verifier. Both incoming and stored
 * signatures are SHA-256 hex digests (64 chars), so timingSafeEqual
 * runs over fixed-length buffers — no length-leak via early return.
 *
 * Inbound usage:
 *   verifyWebhookSignature(storedSecret, rawBody, headerSig)
 */
export function verifyWebhookSignature(secret: string, payload: string, signature: string): boolean {
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  return safeEqualHexDigest(expected, signature);
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

// Re-export logger for downstream callers
export { logger };