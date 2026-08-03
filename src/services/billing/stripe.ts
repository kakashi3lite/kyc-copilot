import Stripe from "stripe";
import { env } from "../../config/env.js";
import { childLogger } from "../../config/logger.js";

const log = childLogger({ component: "stripe-billing" });

export interface SubscriptionState {
  status: string;
  currentPeriodEnd: number;
  cancelAtPeriodEnd: boolean;
  planId: string | null;
  trialEnd: number | null;
}

export interface InvoiceSummary {
  id: string;
  amountPaid: number;
  status: string;
  hostedInvoiceUrl: string | null;
  created: number;
}

/**
 * Thin wrapper around the Stripe SDK. Every method is fail-soft: if
 * STRIPE_SECRET_KEY is empty (dev / zero-key mode) the underlying client
 * is null and every method returns null/false — callers treat that as
 * "billing unavailable" and the product keeps working (demo mode).
 *
 * Methods added for the Business MVP (Phase A):
 *   - createCheckoutSession          hosted Checkout for new subscriptions
 *   - createCustomerPortalSession    Stripe Customer Portal (plan mgmt)
 *   - getSubscription                fetch current subscription state
 *   - cancelSubscription             cancel at period end
 *   - recordUsage                    NOW REAL — reports to Stripe metering
 *   - listInvoices                   last N paid invoices for the dashboard
 *   - verifyWebhookSignature         signature check for /stripe/webhook
 *
 * Note on apiVersion: the installed SDK (v17.5.0) pins its own default API
 * version ('2024-12-18.acacia'). We deliberately do NOT override it — the
 * original plan suggested passing `"2025-06-15" as any`, but that version
 * string is not in the SDK's type union and forcing a mismatched version
 * risks unexpected payload shapes. The SDK default is the safest choice.
 */
export class StripeBillingClient {
  private client: Stripe | null = null;
  private get stripe(): Stripe | null {
    if (env.STRIPE_SECRET_KEY.length === 0) return null;
    this.client ??= new Stripe(env.STRIPE_SECRET_KEY);
    return this.client;
  }

  /**
   * Create a Stripe customer for a tenant (called at self-serve signup).
   * @returns the Stripe customer id, or null when billing is unavailable.
   */
  public async createCustomer(name: string, email?: string): Promise<string | null> {
    const stripe = this.stripe;
    if (stripe === null) return null;
    try {
      const customer = await stripe.customers.create(email !== undefined ? { name, email } : { name });
      return customer.id;
    } catch (error) {
      log.error({ error: error instanceof Error ? error.message : String(error) }, "createCustomer failed");
      return null;
    }
  }

  /**
   * Create a hosted Checkout session for a new subscription.
   * @returns the Checkout URL the user should be redirected to, or null.
   */
  public async createCheckoutSession(params: {
    customerId: string;
    priceId: string;
    tenantId: string;
    successUrl: string;
    cancelUrl: string;
    trialDays?: number;
  }): Promise<string | null> {
    const stripe = this.stripe;
    if (stripe === null) return null;
    try {
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: params.customerId,
        line_items: [{ price: params.priceId, quantity: 1 }],
        success_url: params.successUrl,
        cancel_url: params.cancelUrl,
        client_reference_id: params.tenantId,
        subscription_data: {
          metadata: { tenant_id: params.tenantId },
          ...(params.trialDays !== undefined ? { trial_period_days: params.trialDays } : {}),
        },
        metadata: { tenant_id: params.tenantId },
      });
      return session.url;
    } catch (error) {
      log.error({ error: error instanceof Error ? error.message : String(error) }, "createCheckoutSession failed");
      return null;
    }
  }

  /**
   * Create a Stripe Customer Portal session so the customer can manage
   * their subscription (upgrade, cancel, update payment method, invoices)
   * without leaving the dashboard.
   * @returns the Portal URL, or null when billing is unavailable.
   */
  public async createCustomerPortalSession(params: {
    customerId: string;
    returnUrl: string;
  }): Promise<string | null> {
    const stripe = this.stripe;
    if (stripe === null) return null;
    try {
      const session = await stripe.billingPortal.sessions.create({
        customer: params.customerId,
        return_url: params.returnUrl,
      });
      return session.url;
    } catch (error) {
      log.error({ error: error instanceof Error ? error.message : String(error) }, "createCustomerPortalSession failed");
      return null;
    }
  }

  /**
   * Fetch the current state of a subscription. Used by the dashboard
   * billing page and by the webhook handler to sync state.
   */
  public async getSubscription(subscriptionId: string): Promise<SubscriptionState | null> {
    const stripe = this.stripe;
    if (stripe === null) return null;
    try {
      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      return {
        status: sub.status,
        currentPeriodEnd: sub.current_period_end,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        planId: sub.items.data[0]?.price.id ?? null,
        trialEnd: sub.trial_end ?? null,
      };
    } catch (error) {
      log.error({ error: error instanceof Error ? error.message : String(error) }, "getSubscription failed");
      return null;
    }
  }

  /**
   * Cancel a subscription at the end of the current billing period.
   * The customer retains access until the period ends.
   */
  public async cancelSubscription(subscriptionId: string): Promise<boolean> {
    const stripe = this.stripe;
    if (stripe === null) return false;
    try {
      await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
      return true;
    } catch (error) {
      log.error({ error: error instanceof Error ? error.message : String(error) }, "cancelSubscription failed");
      return false;
    }
  }

  /**
   * Report usage to Stripe for metered billing. Idempotent via the
   * idempotencyKey (which callers derive from the case id + month so a
   * retry never double-counts). Returns the Stripe usage record id, or
   * null when billing is unavailable / the subscription has no item.
   */
  public async recordUsage(params: {
    subscriptionId: string;
    quantity: number;
    idempotencyKey: string;
  }): Promise<string | null> {
    const stripe = this.stripe;
    if (stripe === null) return null;
    try {
      const subscription = await stripe.subscriptions.retrieve(params.subscriptionId);
      const subscriptionItemId = subscription.items.data[0]?.id;
      if (subscriptionItemId === undefined) {
        log.warn({ subscriptionId: params.subscriptionId }, "no subscription item found for usage record");
        return null;
      }
      const record = await stripe.subscriptionItems.createUsageRecord(
        subscriptionItemId,
        { quantity: params.quantity, action: "increment", timestamp: Math.floor(Date.now() / 1000) },
        { idempotencyKey: params.idempotencyKey },
      );
      return record.id;
    } catch (error) {
      log.error({ error: error instanceof Error ? error.message : String(error) }, "recordUsage failed");
      return null;
    }
  }

  /**
   * List the most recent paid invoices for a customer (used by the
   * billing dashboard page). Returns null when billing is unavailable.
   */
  public async listInvoices(customerId: string, limit = 12): Promise<InvoiceSummary[] | null> {
    const stripe = this.stripe;
    if (stripe === null) return null;
    try {
      const invoices = await stripe.invoices.list({ customer: customerId, limit, status: "paid" });
      return invoices.data.map((inv) => ({
        id: inv.id,
        amountPaid: inv.amount_paid,
        status: inv.status ?? "unknown",
        hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
        created: inv.created,
      }));
    } catch (error) {
      log.error({ error: error instanceof Error ? error.message : String(error) }, "listInvoices failed");
      return null;
    }
  }

  /**
   * Verify a Stripe webhook signature. Extracted as a method so the
   * webhook route does not have to construct its own Stripe instance
   * (avoids the CJS/ESM interop pitfall seen with `pg`).
   */
  public verifyWebhookSignature(rawBody: string, signature: string): Stripe.Event | null {
    const stripe = this.stripe;
    if (stripe === null || env.STRIPE_WEBHOOK_SECRET.length === 0) return null;
    try {
      return stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
    } catch (error) {
      log.warn({ error: error instanceof Error ? error.message : String(error) }, "invalid stripe webhook signature");
      return null;
    }
  }
}
