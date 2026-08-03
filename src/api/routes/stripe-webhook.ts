import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type Stripe from "stripe";
import { env } from "../../config/env.js";
import { childLogger } from "../../config/logger.js";
import { db } from "../../db/index.js";
import { stripeEvents, tenants } from "../../db/schema.js";
import { StripeBillingClient } from "../../services/billing/stripe.js";

const log = childLogger({ component: "stripe-webhook" });
const stripeClient = new StripeBillingClient();

export const stripeWebhookRoutes = new Hono();

/**
 * POST /stripe/webhook
 *
 * Public endpoint (NO auth middleware — Stripe signs the request instead).
 * Raw body + `Stripe-Signature` header are verified before any processing.
 *
 * CRITICAL: Hono's `c.req.text()` must read the raw body — this route is
 * registered BEFORE any body-parsing middleware in src/api/index.ts so the
 * signature verification sees the untouched payload.
 *
 * All events are logged to the stripe_events table (event id is the PK,
 * which doubles as the idempotency key) — duplicate deliveries return 200
 * without side effects, and every event is retained for audit.
 */
stripeWebhookRoutes.post("/stripe/webhook", async (c) => {
  const signature = c.req.header("stripe-signature");
  if (signature === undefined || env.STRIPE_WEBHOOK_SECRET === "") {
    return c.json({ error: "Missing stripe-signature header" }, 400);
  }

  const rawBody = await c.req.text();
  const event = stripeClient.verifyWebhookSignature(rawBody, signature);
  if (event === null) {
    // Signature invalid or billing not configured — 400 so Stripe retries
    // once the secret is configured; a missing signature is never trusted.
    return c.json({ error: "Invalid signature" }, 400);
  }

  // Idempotency: the Stripe event id is the PK of stripe_events. A replayed
  // event already exists → acknowledge with no side effects.
  const existing = await db.select({ id: stripeEvents.id }).from(stripeEvents).where(eq(stripeEvents.id, event.id)).limit(1);
  if (existing.length > 0) {
    return c.json({ received: true, deduplicated: true });
  }

  // Log the event BEFORE processing so nothing is ever lost.
  const raw = event.data.object as unknown as { client_reference_id?: string; metadata?: { tenant_id?: string } };
  const tenantId = raw.client_reference_id ?? raw.metadata?.tenant_id ?? null;
  await db.insert(stripeEvents).values({
    id: event.id,
    type: event.type,
    tenantId,
    payload: event.data as unknown as Record<string, unknown>,
  });

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;
      case "customer.subscription.updated":
        await handleSubscriptionUpdated(event.data.object as Stripe.Subscription);
        break;
      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;
      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        log.info({ invoiceId: invoice.id, amountPaid: invoice.amount_paid }, "invoice paid");
        break;
      }
      case "invoice.payment_failed": {
        // 🔔5 — subscription at risk. The subscription.updated event also
        // fires with status "past_due"; marking here is a belt-and-braces.
        const invoice = event.data.object as Stripe.Invoice;
        await markTenantPastDue(invoice.subscription);
        break;
      }
      default:
        log.debug({ type: event.type }, "unhandled stripe event type");
    }
  } catch (error) {
    // Never throw to Stripe: the event is already persisted for manual
    // reconciliation, and returning non-2xx would trigger pointless retries.
    log.error({ error: error instanceof Error ? error.message : String(error), eventId: event.id }, "failed to process stripe event");
  }

  return c.json({ received: true });
});

// ── Event handlers ─────────────────────────────────────────────────────────

async function handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
  const tenantId = session.client_reference_id ?? session.metadata?.tenant_id;
  if (tenantId === undefined) {
    log.warn({ sessionId: session.id }, "checkout session missing tenant_id");
    return;
  }
  const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
  await db.update(tenants)
    .set({
      stripeSubscriptionId: subscriptionId ?? null,
      subscriptionStatus: "active",
      updatedAt: new Date(),
    })
    .where(eq(tenants.id, tenantId));
  log.info({ tenantId, subscriptionId }, "subscription activated via checkout");
}

async function handleSubscriptionUpdated(subscription: Stripe.Subscription): Promise<void> {
  const tenantId = subscription.metadata?.tenant_id;
  if (tenantId === undefined) {
    // Fall back to a lookup by subscription id (partial unique index).
    const tenant = await db.select({ id: tenants.id }).from(tenants)
      .where(eq(tenants.stripeSubscriptionId, subscription.id)).limit(1);
    const tenantRow = tenant[0];
    if (tenantRow === undefined) {
      log.warn({ subscriptionId: subscription.id }, "subscription update for unknown tenant");
      return;
    }
    await syncSubscriptionState(tenantRow.id, subscription);
    return;
  }
  await syncSubscriptionState(tenantId, subscription);
}

/** Sync a tenant's subscription state from a Stripe subscription object. */
async function syncSubscriptionState(tenantId: string, subscription: Stripe.Subscription): Promise<void> {
  const status = subscription.cancel_at_period_end ? "canceled" : subscription.status;
  const priceId = subscription.items.data[0]?.price.id ?? null;
  await db.update(tenants)
    .set({
      subscriptionStatus: status,
      stripeSubscriptionId: subscription.id,
      stripePriceId: priceId,
      trialEndsAt: subscription.trial_end !== null ? new Date(subscription.trial_end * 1000) : null,
      updatedAt: new Date(),
    })
    .where(eq(tenants.id, tenantId));
  log.info({ tenantId, status, priceId }, "subscription synced");
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
  const tenantId = subscription.metadata?.tenant_id;
  if (tenantId === undefined) {
    const tenant = await db.select({ id: tenants.id }).from(tenants)
      .where(eq(tenants.stripeSubscriptionId, subscription.id)).limit(1);
    const tenantRow = tenant[0];
    if (tenantRow === undefined) return;
    await db.update(tenants).set({ subscriptionStatus: "inactive", updatedAt: new Date() }).where(eq(tenants.id, tenantRow.id));
    return;
  }
  await db.update(tenants).set({ subscriptionStatus: "inactive", updatedAt: new Date() }).where(eq(tenants.id, tenantId));
  log.info({ tenantId }, "subscription deleted — tenant marked inactive");
}

/** Mark a tenant past_due when an invoice payment fails (🔔5). */
async function markTenantPastDue(subscriptionId: string | Stripe.Subscription | null): Promise<void> {
  if (typeof subscriptionId !== "string" || subscriptionId.length === 0) return;
  const tenant = await db.select({ id: tenants.id }).from(tenants)
    .where(and(eq(tenants.stripeSubscriptionId, subscriptionId))).limit(1);
  const tenantRow = tenant[0];
  if (tenantRow === undefined) return;
  await db.update(tenants).set({ subscriptionStatus: "past_due", updatedAt: new Date() }).where(eq(tenants.id, tenantRow.id));
  log.info({ tenantId: tenantRow.id }, "subscription past_due — payment needs attention");
}
