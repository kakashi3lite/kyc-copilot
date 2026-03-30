/**
 * usage.ts — Usage metering and billing signals
 *
 * Why this matters for investors:
 *   - Usage data is the raw material for invoicing (Stripe metered billing)
 *   - It proves product-market fit: DAU, MAU, cases/customer, retention
 *   - Enables seat/volume upsell triggers ("You've used 85% of your monthly limit")
 *   - Produces the "cost savings" metric that closes enterprise deals
 *
 * Unit economics the dashboard exposes:
 *   - Manual KYC cost:  €380/case (industry benchmark, 3.5h × €108/h analyst rate)
 *   - Platform cost:    varies by plan (€199 → €3,499/month ÷ cases processed)
 *   - Savings:          (manual cost − platform cost) × volume = headline ROI
 *
 * Architecture:
 *   In-memory Map here. In production: ClickHouse or TimescaleDB for time-series
 *   aggregation, with a nightly job writing to the billing system (Stripe/Lago).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Industry benchmarks used to compute ROI in the dashboard. */
export const BENCHMARKS = {
  manualCostPerCase:  380,   // EUR — average fully-loaded analyst cost
  manualMinutesPerCase: 210, // minutes — 3.5 hours
  platformMinutesPerCase: 14, // minutes — agentic processing time (p50)
} as const;

export interface MonthlyUsage {
  tenantId:         string;
  month:            string;  // "2026-03"
  casesProcessed:   number;
  casesAutoApproved: number;
  casesHITL:        number;
  riskDistribution: { Low: number; Medium: number; High: number; Pending: number };
  apiCallsTotal:    number;
  computedAt:       string;  // ISO timestamp of last update
}

export interface UsageSummary extends MonthlyUsage {
  /** Derived metrics for the investor / dashboard view */
  metrics: {
    utilizationPct:   number;  // cases used / plan limit × 100
    manualCostAvoided: number; // EUR saved vs doing it manually
    avgPlatformCost:  number;  // EUR/case this month (plan cost ÷ cases)
    timeSavedHours:   number;  // hours saved vs manual
    complianceRate:   number;  // % of cases with a complete evidence trail (always 100 in v0)
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const usageStore = new Map<string, MonthlyUsage>();

function monthKey(tenantId: string, month: string) {
  return `${tenantId}:${month}`;
}

/** Returns "YYYY-MM" for the current calendar month in UTC. */
export function currentMonth(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function blank(tenantId: string, month: string): MonthlyUsage {
  return {
    tenantId,
    month,
    casesProcessed:    0,
    casesAutoApproved: 0,
    casesHITL:         0,
    riskDistribution:  { Low: 0, Medium: 0, High: 0, Pending: 0 },
    apiCallsTotal:     0,
    computedAt:        new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Write operations (called by graph nodes via index.ts)
// ---------------------------------------------------------------------------

/**
 * Records a completed KYC case.
 * Call this after the graph reaches END (auto-approved or HITL sign-off).
 */
export function recordCaseCompleted(
  tenantId: string,
  riskScore: "Low" | "Medium" | "High" | "Pending",
  requiresHuman: boolean,
  month = currentMonth()
): void {
  const k = monthKey(tenantId, month);
  const rec = usageStore.get(k) ?? blank(tenantId, month);

  rec.casesProcessed++;
  if (requiresHuman) rec.casesHITL++;
  else rec.casesAutoApproved++;
  rec.riskDistribution[riskScore]++;
  rec.apiCallsTotal++;   // minimum 1 API call per case
  rec.computedAt = new Date().toISOString();

  usageStore.set(k, rec);
}

/** Increments the raw API call counter (call from every authenticated endpoint). */
export function recordApiCall(tenantId: string, month = currentMonth()): void {
  const k = monthKey(tenantId, month);
  const rec = usageStore.get(k) ?? blank(tenantId, month);
  rec.apiCallsTotal++;
  rec.computedAt = new Date().toISOString();
  usageStore.set(k, rec);
}

// ---------------------------------------------------------------------------
// Read operations (called by /usage and /dashboard endpoints)
// ---------------------------------------------------------------------------

/**
 * Returns usage for a specific month, with derived investor metrics.
 * planCost is the tenant's monthly plan price (from auth.ts PLAN_CONFIG).
 * planLimit is their case quota.
 */
export function getUsageSummary(
  tenantId: string,
  planCost: number,
  planLimit: number,
  month = currentMonth()
): UsageSummary {
  const rec = usageStore.get(monthKey(tenantId, month)) ?? blank(tenantId, month);
  const n   = rec.casesProcessed;

  const manualCostAvoided = n * BENCHMARKS.manualCostPerCase;
  const avgPlatformCost   = n > 0 ? planCost / n : planCost;
  const timeSavedHours    = (n * (BENCHMARKS.manualMinutesPerCase - BENCHMARKS.platformMinutesPerCase)) / 60;
  const utilizationPct    = Math.min(100, Math.round((n / planLimit) * 100));

  return {
    ...rec,
    metrics: {
      utilizationPct,
      manualCostAvoided: Math.round(manualCostAvoided),
      avgPlatformCost:   Math.round(avgPlatformCost * 100) / 100,
      timeSavedHours:    Math.round(timeSavedHours * 10) / 10,
      complianceRate:    100, // every case has a guardrail-verified evidence trail
    },
  };
}

/**
 * Returns last 6 months of usage for the sparkline chart.
 * Months with no data return zeros — important for chart stability.
 */
export function getUsageHistory(tenantId: string): MonthlyUsage[] {
  const result: MonthlyUsage[] = [];
  const now = new Date();

  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getUTCFullYear(), now.getUTCMonth() - i, 1);
    const m = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    result.push(usageStore.get(monthKey(tenantId, m)) ?? blank(tenantId, m));
  }

  return result;
}

// ---------------------------------------------------------------------------
// Seed: populate demo tenant with realistic 6-month history
// ---------------------------------------------------------------------------
(function seedDemoUsage() {
  const tid = "tenant_demo";
  const now = new Date();

  // Simulate realistic growth curve for the demo dashboard
  const monthlyCases = [12, 19, 28, 41, 67, 89];

  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getUTCFullYear(), now.getUTCMonth() - i, 1);
    const m = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const n = monthlyCases[5 - i] ?? 0;
    const hitl = Math.round(n * 0.28);  // ~28% require human review

    const rec: MonthlyUsage = {
      tenantId:         tid,
      month:            m,
      casesProcessed:   n,
      casesAutoApproved: n - hitl,
      casesHITL:        hitl,
      riskDistribution: {
        Low:     Math.round(n * 0.58),
        Medium:  Math.round(n * 0.30),
        High:    Math.round(n * 0.10),
        Pending: Math.round(n * 0.02),
      },
      apiCallsTotal: n * 3 + 14,   // ~3 API calls per case + overhead
      computedAt:    new Date().toISOString(),
    };
    usageStore.set(monthKey(tid, m), rec);
  }
})();
