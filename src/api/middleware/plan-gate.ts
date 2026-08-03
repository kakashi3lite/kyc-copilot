import type { Context, Next } from "hono";
import { and, eq } from "drizzle-orm";
import { getAuth } from "./auth.js";
import { problem } from "./error-handler.js";
import { db } from "../../db/index.js";
import { plans, tenants, usage } from "../../db/schema.js";
import { env } from "../../config/env.js";
import { childLogger } from "../../config/logger.js";
import { monthKey } from "../../utils/date.js";

const log = childLogger({ component: "plan-gate" });

/** Plans with this casesPerMonth value are effectively unlimited. */
const UNLIMITED = 99999;

/**
 * Middleware factory: enforce plan quota limits at the API boundary
 * (D5 — centralized enforcement instead of scattered `plan === "starter"`
 * checks).
 *
 *   caseRoutes.post("/", requirePlanLimit("cases"), handler);
 *
 * Behavior:
 *   - Tenant not found            → 404
 *   - Inactive/canceled/past_due subscription AND billing configured → 402
 *     with upgradeUrl. When STRIPE_SECRET_KEY is empty (dev/zero-key mode)
 *     the subscription check is skipped so the demo keeps working.
 *   - Usage ≥ plan casesPerMonth  → 402 Payment Required with
 *     {currentUsage, limit, upgradeUrl} (customer trigger 🔔2).
 *   - Enterprise / missing plan   → pass through (no artificial limits).
 */
export function requirePlanLimit(resource: "cases" | "apiCalls" | "reports") {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const auth = getAuth(c);

    const tenant = await db
      .select({ plan: tenants.plan, subscriptionStatus: tenants.subscriptionStatus })
      .from(tenants)
      .where(eq(tenants.id, auth.tenantId))
      .limit(1);
    const tenantRow = tenant[0];
    if (tenantRow === undefined) {
      return problem(c, 404, "Not Found", "Tenant not found");
    }

    // Subscription gating only applies when billing is configured. In
    // zero-key dev mode the demo tenant has subscription_status 'inactive'
    // (migration default) and would otherwise be locked out of the flow.
    if (env.STRIPE_SECRET_KEY.length > 0) {
      const status = tenantRow.subscriptionStatus;
      if (status === "inactive" || status === "canceled") {
        return c.json({
          error: "Subscription required",
          type: "https://kyc-copilot.local/problems/402",
          title: "Payment Required",
          status: 402,
          detail: "Your subscription is inactive. Please update your payment method to continue.",
          upgradeUrl: "/app#billing",
        }, 402);
      }
    }

    const plan = await db
      .select({ casesPerMonth: plans.casesPerMonth })
      .from(plans)
      .where(eq(plans.id, tenantRow.plan))
      .limit(1);
    const planRow = plan[0];
    if (planRow === undefined) {
      // No plan definition (pre-seed) — fail open, never invent a limit.
      log.warn({ tenantId: auth.tenantId, plan: tenantRow.plan }, "no plan definition found — allowing");
      return await next();
    }

    const limit = planRow.casesPerMonth;
    if (limit >= UNLIMITED) {
      return await next(); // Enterprise — unlimited
    }

    const month = monthKey();
    const usageRow = await db
      .select({ casesProcessed: usage.casesProcessed })
      .from(usage)
      .where(and(eq(usage.tenantId, auth.tenantId), eq(usage.month, month)))
      .limit(1);
    const used = usageRow[0]?.casesProcessed ?? 0;

    if (resource === "cases" && used >= limit) {
      return c.json({
        error: "Plan limit exceeded",
        type: "https://kyc-copilot.local/problems/402",
        title: "Payment Required",
        status: 402,
        detail: `You have processed ${used} of ${limit} cases this month. Upgrade your plan to continue.`,
        currentUsage: used,
        limit,
        upgradeUrl: "/app#billing",
      }, 402);
    }

    return await next();
  };
}
