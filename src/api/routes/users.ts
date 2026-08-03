import { Hono } from "hono";
import bcrypt from "bcrypt";
import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/index.js";
import { users } from "../../db/schema.js";
import { requireAdmin, getAuth } from "../middleware/auth.js";
import { validateJson, getValidated } from "../middleware/validate.js";
import { problem } from "../middleware/error-handler.js";
import { newId } from "../../utils/id.js";
import { childLogger } from "../../config/logger.js";

const log = childLogger({ component: "users" });

const inviteSchema = z.object({ email: z.string().email(), role: z.enum(["admin", "analyst"]).default("analyst") });
const roleSchema = z.object({ role: z.enum(["admin", "analyst"]) });

export const userRoutes = new Hono();

/**
 * GET /users — admin only. Lists the tenant's active team members with
 * role and last-login info (Phase D / 🔔7).
 */
userRoutes.get("/users", async (c) => {
  const denied = requireAdmin(c);
  if (denied !== null) return denied;
  const auth = getAuth(c);
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      role: users.role,
      name: users.name,
      lastLoginAt: users.lastLoginAt,
      invitedAt: users.invitedAt,
      inviteAcceptedAt: users.inviteAcceptedAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(and(eq(users.tenantId, auth.tenantId), isNull(users.deactivatedAt)))
    .orderBy(users.createdAt);
  return c.json({ users: rows });
});

/**
 * POST /users/invite — admin only. Creates the user with a random temp
 * password. In dev the credentials are logged; production wires Resend to
 * email the invite (EmailService is a documented stub).
 */
userRoutes.post("/users/invite", validateJson(inviteSchema), async (c) => {
  const denied = requireAdmin(c);
  if (denied !== null) return denied;
  const auth = getAuth(c);
  const body = getValidated<z.infer<typeof inviteSchema>>(c);

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, body.email)).limit(1);
  if (existing.length > 0) return problem(c, 409, "Conflict", "A user with this email already exists");

  const userId = newId("usr");
  const tempPassword = `Kyc!${randomBytes(12).toString("base64url")}`;
  await db.insert(users).values({
    id: userId,
    tenantId: auth.tenantId,
    email: body.email,
    passwordHash: await bcrypt.hash(tempPassword, 12),
    role: body.role,
    invitedAt: new Date(),
  });
  // 🔔7 — the invite-accepted trigger keys off inviteAcceptedAt (set at first login).
  log.info({ email: body.email, role: body.role, tempPassword }, "team member invited (dev: share temp credentials)");
  return c.json({ id: userId, email: body.email, role: body.role }, 201);
});

/**
 * PATCH /users/:id/role — admin only. Cannot change your own role
 * (prevents the last admin from demoting themselves and locking the team out).
 */
userRoutes.patch("/users/:id/role", validateJson(roleSchema), async (c) => {
  const denied = requireAdmin(c);
  if (denied !== null) return denied;
  const auth = getAuth(c);
  const targetId = c.req.param("id") ?? "";
  if (auth.userId !== undefined && targetId === auth.userId) {
    return problem(c, 403, "Forbidden", "You cannot change your own role");
  }
  const body = getValidated<z.infer<typeof roleSchema>>(c);
  const result = await db.update(users).set({ role: body.role, updatedAt: new Date() })
    .where(and(eq(users.id, targetId), eq(users.tenantId, auth.tenantId)));
  if (result.rowCount === 0) return problem(c, 404, "Not Found", "User not found");
  return c.json({ id: targetId, role: body.role });
});

/**
 * DELETE /users/:id — admin only. Soft-delete via deactivated_at; cannot
 * remove your own account (403).
 */
userRoutes.delete("/users/:id", async (c) => {
  const denied = requireAdmin(c);
  if (denied !== null) return denied;
  const auth = getAuth(c);
  const targetId = c.req.param("id") ?? "";
  if (auth.userId !== undefined && targetId === auth.userId) {
    return problem(c, 403, "Forbidden", "You cannot remove your own account");
  }
  const result = await db.update(users).set({ deactivatedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(users.id, targetId), eq(users.tenantId, auth.tenantId), isNull(users.deactivatedAt)));
  if (result.rowCount === 0) return problem(c, 404, "Not Found", "User not found");
  return c.json({ id: targetId, deactivated: true });
});
