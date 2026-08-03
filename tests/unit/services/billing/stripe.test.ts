import { describe, expect, it } from "vitest";
import { StripeBillingClient } from "../../../../src/services/billing/stripe.js";

/**
 * In the default test env STRIPE_SECRET_KEY is empty, so every method
 * exercises the fail-soft null path (dev / zero-key mode). This documents
 * the contract: billing methods NEVER throw and return null/false when
 * billing is unavailable.
 */
describe("StripeBillingClient — fail-soft contract (no key)", () => {
  const client = new StripeBillingClient();

  it("createCustomer returns null", async () => {
    expect(await client.createCustomer("Acme BV", "a@b.test")).toBeNull();
  });

  it("createCheckoutSession returns null", async () => {
    const url = await client.createCheckoutSession({
      customerId: "cus_x",
      priceId: "price_x",
      tenantId: "ten_x",
      successUrl: "http://localhost/app",
      cancelUrl: "http://localhost/signup",
      trialDays: 14,
    });
    expect(url).toBeNull();
  });

  it("createCustomerPortalSession returns null", async () => {
    expect(await client.createCustomerPortalSession({ customerId: "cus_x", returnUrl: "http://localhost/app#billing" })).toBeNull();
  });

  it("getSubscription returns null", async () => {
    expect(await client.getSubscription("sub_x")).toBeNull();
  });

  it("cancelSubscription returns false", async () => {
    expect(await client.cancelSubscription("sub_x")).toBe(false);
  });

  it("recordUsage returns null", async () => {
    expect(await client.recordUsage({ subscriptionId: "sub_x", quantity: 1, idempotencyKey: "case:abc" })).toBeNull();
  });

  it("listInvoices returns null", async () => {
    expect(await client.listInvoices("cus_x")).toBeNull();
  });

  it("verifyWebhookSignature returns null without a webhook secret", () => {
    expect(client.verifyWebhookSignature("raw", "sig")).toBeNull();
  });
});
