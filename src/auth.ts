/**
 * auth.ts — API key authentication + tenant management
 *
 * Market rationale (investor lens):
 *   API key gating is the first commercial primitive. Without it you cannot:
 *   - attribute usage to a customer
 *   - enforce plan limits
 *   - generate invoices
 *   - sell enterprise deals with SSO/SAML
 *
 * Architecture:
 *   Keys are stored in-memory here (Map). In production, swap `keyStore` for
 *   a Postgres query — the interface stays identical. Every function is typed
 *   so callers never touch raw store internals.
 *
 * Key format: "kc_live_<32 hex chars>"
 *   - "kc_" brand prefix (like Stripe's "sk_live_")
 *   - "live_" vs "test_" environment tag
 *   - 128-bit random suffix (UUID v4 without hyphens)
 */

import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Pricing tiers — maps to monthly case limits and feature flags. */
export type Plan = "starter" | "growth" | "enterprise";

/**
 * Represents one paying customer / institution.
 * In production this lives in a `tenants` table.
 */
export interface Tenant {
  tenantId:    string;
  name:        string;     // e.g. "Acme Payments BV"
  plan:        Plan;
  monthlyLimit: number;   // max KYC cases per calendar month
  createdAt:   Date;
  active:      boolean;
}

/**
 * One API key belonging to a tenant.
 * A tenant can have multiple keys (e.g. prod + staging).
 */
export interface ApiKey {
  key:      string;        // full key string "kc_live_..."
  tenantId: string;
  label:    string;        // human-readable e.g. "Production"
  createdAt: Date;
  lastUsed: Date | null;
}

// ---------------------------------------------------------------------------
// Plan configuration
// ---------------------------------------------------------------------------

/**
 * Gen-X pricing: transparent, no dark patterns, published on the website.
 * Positioned ABOVE ComplyAdvantage ($99-$120/month for raw screening) because
 * we deliver a complete AMLD6-aligned EDD dossier, not just API hits.
 */
export const PLAN_CONFIG: Record<Plan, {
  displayName:  string;
  priceMonthly: number;    // EUR
  caseLimit:    number;    // per calendar month
  features:     string[];
}> = {
  starter: {
    displayName:  "Starter",
    priceMonthly: 199,
    caseLimit:    50,
    features: [
      "50 KYC cases/month",
      "REST API access",
      "Evidence ledger",
      "JSON compliance reports",
      "Email support",
    ],
  },
  growth: {
    displayName:  "Growth",
    priceMonthly: 799,
    caseLimit:    500,
    features: [
      "500 KYC cases/month",
      "Webhooks",
      "PDF + JSON reports",
      "5 team seats",
      "Ongoing re-screening",
      "Priority support",
    ],
  },
  enterprise: {
    displayName:  "Enterprise",
    priceMonthly: 3499,
    caseLimit:    999_999, // effectively unlimited
    features: [
      "Unlimited cases",
      "Custom SLA",
      "20 team seats",
      "SAML/SSO",
      "On-prem deployment",
      "Dedicated AML engineer",
      "Audit-ready reporting",
    ],
  },
};

// ---------------------------------------------------------------------------
// In-memory stores (swap for Postgres in production)
// ---------------------------------------------------------------------------

const tenantStore = new Map<string, Tenant>();
const keyStore    = new Map<string, ApiKey>();   // key string → ApiKey
const keyByTenant = new Map<string, string[]>(); // tenantId → key strings

// ---------------------------------------------------------------------------
// Seed: pre-create a demo tenant so the UI works without an account flow
// ---------------------------------------------------------------------------

/** Pre-seeded demo API key — shown in the Settings panel of the dashboard. */
export const DEMO_KEY = "kc_live_demo0000000000000000000000";

function seedDemo() {
  const tid = "tenant_demo";
  tenantStore.set(tid, {
    tenantId:    tid,
    name:        "Demo Institution",
    plan:        "growth",
    monthlyLimit: PLAN_CONFIG.growth.caseLimit,
    createdAt:   new Date("2025-01-15"),
    active:      true,
  });
  const k: ApiKey = {
    key:      DEMO_KEY,
    tenantId: tid,
    label:    "Production",
    createdAt: new Date("2025-01-15"),
    lastUsed: null,
  };
  keyStore.set(DEMO_KEY, k);
  keyByTenant.set(tid, [DEMO_KEY]);
}
seedDemo();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validates a Bearer token from the Authorization header.
 * Returns the tenant record if valid, null otherwise.
 * Also updates `lastUsed` timestamp on the key.
 */
export function authenticate(rawHeader: string | undefined): Tenant | null {
  if (!rawHeader) return null;

  // Accept "Bearer kc_live_..." or just the key directly
  const key = rawHeader.startsWith("Bearer ")
    ? rawHeader.slice(7).trim()
    : rawHeader.trim();

  const keyRecord = keyStore.get(key);
  if (!keyRecord) return null;

  const tenant = tenantStore.get(keyRecord.tenantId);
  if (!tenant || !tenant.active) return null;

  // Record last-used timestamp (fire-and-forget — don't fail the request)
  keyRecord.lastUsed = new Date();

  return tenant;
}

/**
 * Creates a new tenant and issues its first API key.
 * Called during sign-up / provisioning flows.
 */
export function createTenant(name: string, plan: Plan): { tenant: Tenant; apiKey: ApiKey } {
  const tenantId = `tenant_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const tenant: Tenant = {
    tenantId,
    name,
    plan,
    monthlyLimit: PLAN_CONFIG[plan].caseLimit,
    createdAt:   new Date(),
    active:      true,
  };
  tenantStore.set(tenantId, tenant);

  const apiKey = issueApiKey(tenantId, "Production");
  return { tenant, apiKey };
}

/**
 * Issues a new API key for an existing tenant.
 * Useful for key rotation and separate staging/prod environments.
 */
export function issueApiKey(tenantId: string, label: string): ApiKey {
  const key = `kc_live_${randomUUID().replace(/-/g, "")}`;
  const record: ApiKey = { key, tenantId, label, createdAt: new Date(), lastUsed: null };
  keyStore.set(key, record);
  keyByTenant.set(tenantId, [...(keyByTenant.get(tenantId) ?? []), key]);
  return record;
}

/**
 * Returns all API keys for a tenant (for the settings UI).
 * Never returns the raw key after first display — here we expose it fully
 * only in the seed (demo) scenario.
 */
export function getApiKeys(tenantId: string): ApiKey[] {
  return (keyByTenant.get(tenantId) ?? [])
    .map((k) => keyStore.get(k))
    .filter((k): k is ApiKey => k !== undefined);
}

export function getTenant(tenantId: string): Tenant | undefined {
  return tenantStore.get(tenantId);
}
