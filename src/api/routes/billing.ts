import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { plans, tenants } from "../../db/schema.js";
import { env } from "../../config/env.js";
import { StripeBillingClient } from "../../services/billing/stripe.js";
import { getUsageSummary } from "../../services/billing/usage-meter.js";
import { getAuth } from "../middleware/auth.js";
import { problem } from "../middleware/error-handler.js";

const stripeClient = new StripeBillingClient();

export const billingRoutes = new Hono();

/**
 * GET /billing — current subscription state, plan metadata, current-month
 * usage and recent invoices, for the Billing tab of the dashboard.
 */
billingRoutes.get("/billing", async (c) => {
  const auth = getAuth(c);

  const tenant = await db
    .select({
      id: tenants.id,
      plan: tenants.plan,
      stripeCustomerId: tenants.stripeCustomerId,
      stripeSubscriptionId: tenants.stripeSubscriptionId,
      stripePriceId: tenants.stripePriceId,
      subscriptionStatus: tenants.subscriptionStatus,
      trialEndsAt: tenants.trialEndsAt,
    })
    .from(tenants)
    .where(eq(tenants.id, auth.tenantId))
    .limit(1);
  const t = tenant[0];
  if (t === undefined) return problem(c, 404, "Not Found", "Tenant not found");

  const plan = await db.select().from(plans).where(eq(plans.id, t.plan)).limit(1);
  const currentUsage = await getUsageSummary(auth.tenantId);

  // Both Stripe calls fail-soft (null) — the dashboard renders gracefully.
  const subscription = t.stripeSubscriptionId !== null
    ? await stripeClient.getSubscription(t.stripeSubscriptionId)
    : null;
  const invoices = t.stripeCustomerId !== null
    ? await stripeClient.listInvoices(t.stripeCustomerId)
    : null;

  return c.json({
    plan: plan[0] ?? null,
    subscriptionStatus: t.subscriptionStatus,
    subscription,
    trialEndsAt: t.trialEndsAt,
    currentUsage,
    invoices: invoices ?? [],
    upgradeUrl: env.STRIPE_SECRET_KEY.length > 0 ? "/app#billing" : null,
  });
});

/**
 * POST /billing/portal — create a Stripe Customer Portal session so the
 * user can self-serve plan changes, invoices, and payment methods.
 */
billingRoutes.post("/billing/portal", async (c) => {
  const auth = getAuth(c);

  const tenant = await db
    .select({ stripeCustomerId: tenants.stripeCustomerId })
    .from(tenants)
    .where(eq(tenants.id, auth.tenantId))
    .limit(1);
  const t = tenant[0];
  if (t === undefined || t.stripeCustomerId === null) {
    return problem(c, 400, "Bad Request", "No billing account for this tenant");
  }

  const url = await stripeClient.createCustomerPortalSession({
    customerId: t.stripeCustomerId,
    returnUrl: `${env.APP_BASE_URL}/app#billing`,
  });
  if (url === null) {
    return problem(c, 502, "Bad Gateway", "Stripe Customer Portal is unavailable — please retry in a moment");
  }
  return c.json({ url });
});
