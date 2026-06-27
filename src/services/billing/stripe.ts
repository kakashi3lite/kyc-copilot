import Stripe from "stripe";
import { env } from "../../config/env.js";

export class StripeBillingClient {
  private client: Stripe | null = null;
  private get stripe(): Stripe | null {
    if (env.STRIPE_SECRET_KEY.length === 0) return null;
    this.client ??= new Stripe(env.STRIPE_SECRET_KEY);
    return this.client;
  }

  public async createCustomer(name: string, email?: string): Promise<string | null> {
    const stripe = this.stripe;
    if (stripe === null) return null;
    const customer = await stripe.customers.create(email !== undefined ? { name, email } : { name });
    return customer.id;
  }

  public async recordUsage(_tenantId: string, _quantity: number): Promise<void> {
    if (this.stripe === null) return;
  }
}
