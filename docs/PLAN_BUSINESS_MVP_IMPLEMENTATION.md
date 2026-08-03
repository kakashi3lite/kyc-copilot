---
repo: kyc-copilot
path: /Users/kakashi3lite/kyc-copilot
doc: PLAN_BUSINESS_MVP_IMPLEMENTATION
title: Business MVP Implementation Guide — From Demo to Sellable Product
status: approved-for-implementation
updated: 2026-08-03
scope: Stripe billing + auth/signup + case dashboard + billing/team views + audit-grade reports + trial landing page + production hardening
decision_anchors: [D1-vanilla-HTML, D2-Stripe-Checkout, D3-JWT-dashboard-auth, D4-self-serve-provision, D5-plan-middleware, D6-content-integrity-signing]
invariants: [INV-001..007, ADR-013, ADR-014, ADR-006]
related:
  - docs/ARCHITECTURE_CONTEXT.md
  - docs/DECISIONS.md
  - docs/SHIPPING_STATUS.md
  - docs/PLAN_MVP_SHIP.md
  - docs/SESSION_REPORT_2026-08-03.md
  - docs/PLAN_UBO_EXTRACTION.md
---

# PLAN — Business MVP: From Demo to Sellable Product

> **TL;DR:** Turn the technically excellent but commercially inert KYC Copilot into a product someone can discover, sign up for, pay for, and use daily — without touching `curl`. Seven phases: billing engine → auth/signup → case management dashboard → billing+team views → audit-grade reports → trial landing page → production hardening. Dashboard stays vanilla HTML (ADR-006). Stripe Checkout handles subscription lifecycle. Self-serve signup + JWT auth replaces the hardcoded API key.

---

## Context Summary — Full Conversation Research

### What the Value Brainstormer Found

KYC Copilot sits in a **genuine market whitespace**: it's an agentic EDD dossier generator that combines multiple data sources, LLM drafting, evidence chains, and HITL decisions — reducing entity due diligence from ~3.5 hours to ~14 minutes per case. The underlying engineering is unusually disciplined for a solo/seed project (O(1) auth, atomic rate limits, fail-open architecture, evidence hash chains, dual-semaphore browser pool). But the product is **pre-revenue** — no billing, no paying customers, no pilot programs.

**Market:** $3.22B (2025) → $6.75B (2030) AML software market, 15.9% CAGR. Regulatory tailwind from AMLA (operational 2025–2026, direct supervision from 2028) and AMLD6 harmonization (applies from 2027). Competitive gap: ComplyAdvantage/Ondato moving upmarket with "agentic workflows" — if they add dossier generation, this whitespace closes.

**Top 5 moves (investor-grade priority):**
1. Wire Stripe billing + real usage metering
2. Land 2–3 EU PSP design partners
3. Replace PKCS#7 placeholder with real digital signatures
4. Raise test coverage to 60%+ with real E2E tests
5. Build self-serve trial flow

### What the Code Audit Found (Reality Ledger)

| Area | Status | Key file |
|---|---|---|
| Stripe billing | `createCustomer()` real; `recordUsage()` **no-op**; no subscription/checkout/webhook methods | `src/services/billing/stripe.ts:28` |
| Usage tracking | Cases + API calls tracked; `costUsd`/tokens never written; `sixMonthHistory` fake | `src/services/billing/usage-meter.ts:11` |
| Plan enforcement | No quota checks anywhere; only ad-hoc `plan === "starter"` guards | `src/api/routes/cases.ts:109` |
| Dashboard auth | **Hardcoded** `kc_live_demo...` API key in JS; no login form; no token storage | `public/app.html:506` |
| Landing page | CTA links to `/app` with no signup gate; ROI calculator truncated; no trial flow | `public/landing.html` |
| Case list | No search, no filter by status/risk, no pagination, no sort controls | `src/api/routes/cases.ts` GET route |
| Case detail | Toast-only summary; no detail panel, no report download button | `public/app.html` |
| Reports | PDF rendered real with Playwright; signature is SHA-256 hash displayed as "PKCS#7 placeholder" | `src/services/reports/pdf-renderer.ts:20` |
| Team management | No `POST /users`, no invite, no role list UI; `GET /tenants/:id/usage` returns `[]` | `src/api/routes/tenants.ts:17-20` |
| Tests | 45 unit tests pass; E2E is `expect([...]).toHaveLength(5)`; coverage 50% lines | `tests/e2e/kyc-lifecycle.test.ts` |

---

## 0. Session Bootstrap (for IMPLEMENTER)

1. Adopt role `IMPLEMENTER` → `docs/roles/IMPLEMENTER.md`, instruction set `IS-001`.
2. Load `docs/ARCHITECTURE_CONTEXT.md` §3, §5, §7, §8, §11 for system map.
3. Read this plan fully — it's the definitive implementation guide.
4. Do NOT delete dead code / unused deps (conservative choice) — document instead.
5. Each phase leaves the repo green: `npm run typecheck && npm run test && npm run build && docker build .`
6. Decision anchors D1–D6 are **locked** — do not re-open without a new ADR.

---

## 1. Locked Design Decisions

| ID | Decision | Rationale |
|---|---|---|
| **D1** | **Dashboard stays vanilla HTML/CSS/JS** (ADR-006). No React, no bundler, no framework. | Accepted ADR — not reopening. We add ES module patterns and keep zero-build-step deployment. |
| **D2** | **Stripe Checkout for subscription management.** Stripe owns the subscription lifecycle (billing, invoices, dunning). We handle webhook events and sync state to DB. | Avoids building billing infrastructure. Stripe's hosted Checkout is PCI-compliant and handles global tax. |
| **D3** | **JWT auth for dashboard users.** Replace the hardcoded API key with email/password login → JWT access + refresh tokens. API keys remain for machine-to-machine (unchanged). | The auth system already supports both modes — we just need a login UI. |
| **D4** | **Self-serve provision = POST /provision + Stripe Checkout.** Signup creates tenant, redirects to Stripe Checkout, webhook activates the subscription. | Atomic: tenant + user + subscription created in one flow. No free tier without a plan. |
| **D5** | **Plan enforcement at API middleware level.** Quota checks (cases/month) happen in middleware, not scattered across routes. Overage returns 402 Payment Required with a link to upgrade. | Centralized enforcement prevents drift. |
| **D6** | **PDF signing via real SHA-256 content hash + HMAC timestamp** (NOT full PKCS#7 with CA-issued cert — deferred to enterprise). | Full PKCS#7 with CA certs requires HSM/KMS infrastructure premature for MVP. HMAC-based signature is auditable (tamper-evident) and independently verifiable. |

---

## 2. Invariants (Will NOT Break)

- **INV-001..INV-007** — all preserved.
- **ADR-013** — deterministic fallback + HITL decision table unchanged.
- **ADR-014** — UBO extraction with soft-degrade unchanged.
- **ADR-006** — vanilla HTML dashboard preserved (no React/build-step).
- **Zero-key demo** — Acme → `completed`/Low, Volkov → `pending_hitl`/High, approve → `completed`, re-approve → 409.
- **`npm run typecheck`** green (all strict flags).
- **`npm run test`** green, coverage increasing per phase.
- **`docker build .`** green.

---

## 3. Pre-flight — Environment & Stripe Setup

### 3.1: Stripe Dashboard Configuration

Before any code changes, configure in [Stripe Dashboard](https://dashboard.stripe.com/test) (test mode first):

```
Products & Prices:
  ┌──────────────────┬───────────┬────────────┬───────────────┐
  │ Product          │ Price ID  │ Amount/mo  │ Cases/mo      │
  ├──────────────────┼───────────┼────────────┼───────────────┤
  │ KYC Starter      │ price_…   │ €99        │ 50 cases      │
  │ KYC Growth       │ price_…   │ €499       │ 500 cases     │
  │ KYC Enterprise   │ price_…   │ Custom     │ Unlimited     │
  └──────────────────┴───────────┴────────────┴───────────────┘

Customer Portal: Enable → set branding → return URL: /app

Webhook Endpoint: https://<your-domain>/stripe/webhook
  Events to listen for:
    - checkout.session.completed
    - customer.subscription.updated
    - customer.subscription.deleted
    - invoice.paid
    - invoice.payment_failed
```

### 3.2: Env Variables

Append to `.env.example` and `infra/fly-secrets.sh`:

```bash
# Stripe
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_STARTER=price_...
STRIPE_PRICE_GROWTH=price_...
STRIPE_PRICE_ENTERPRISE=price_...

# Reports
REPORT_SIGNING_KEY=<openssl rand -hex 32>

# Email (Resend — for password reset + invites)
RESEND_API_KEY=re_...

# App base URL (for Stripe redirects)
APP_BASE_URL=http://localhost:3000
```

### 3.3: Verify Starting State

```bash
npm run typecheck     # must be green
npm run test          # 45 tests pass, coverage ≥50% lines
npm run build         # dist/src/index.js produced
docker build .        # image builds
```

---

## 4. Phase A — Billing Engine

*Files: `src/db/schema.ts`, `src/db/migrations/0002_billing_mvp.sql` (new), `src/services/billing/stripe.ts`, `src/services/billing/usage-meter.ts`, `src/api/routes/usage.ts`, `src/api/routes/stripe-webhook.ts` (new), `src/api/middleware/plan-gate.ts` (new), `src/config/env.ts`*

### A.1: Database Migration

**Create:** `src/db/migrations/0002_billing_mvp.sql`

```sql
-- Add Stripe subscription fields to tenants
ALTER TABLE tenants
  ADD COLUMN stripe_subscription_id TEXT,
  ADD COLUMN stripe_price_id TEXT,
  ADD COLUMN trial_ends_at TIMESTAMPTZ,
  ADD COLUMN subscription_status TEXT NOT NULL DEFAULT 'inactive';

CREATE INDEX tenants_subscription_idx ON tenants (subscription_status);

-- Create plans table (source of truth for plan metadata)
CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  name plan NOT NULL UNIQUE,
  cases_per_month INTEGER NOT NULL,
  price_monthly_usd INTEGER NOT NULL,
  features JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed plan data
INSERT INTO plans (id, name, cases_per_month, price_monthly_usd, features) VALUES
  ('plan_starter', 'starter', 50, 99, '["50 KYC checks/month","Email support","Basic dashboard","GDPR export"]'),
  ('plan_growth', 'growth', 500, 499, '["500 KYC checks/month","Priority support","Webhooks","Rescreening","API access"]'),
  ('plan_enterprise', 'enterprise', 999999, 0, '["Unlimited KYC checks","Dedicated support","Custom integrations","SLA","SSO"]');

-- Add lastLoginAt to users
ALTER TABLE users ADD COLUMN last_login_at TIMESTAMPTZ;

-- Add stripe_event_id to audit_logs for idempotency
ALTER TABLE audit_logs ADD COLUMN stripe_event_id TEXT;
CREATE UNIQUE INDEX audit_stripe_event_unique ON audit_logs (stripe_event_id) WHERE stripe_event_id IS NOT NULL;
```

Run with: `npm run db:generate && npm run db:migrate`

### A.2: Update Schema Type

**File:** `src/db/schema.ts` — add to tenants table after `stripeCustomerId`:

```ts
stripeSubscriptionId: text("stripe_subscription_id"),
stripePriceId: text("stripe_price_id"),
trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
subscriptionStatus: text("subscription_status").notNull().default("inactive"),
```

Add after tenants table indexes:
```ts
subscriptionIdx: index("tenants_subscription_idx").on(table.subscriptionStatus),
```

Add new `plans` table definition:
```ts
export const plans = pgTable("plans", {
  id: text("id").primaryKey(),
  name: planEnum("name").notNull().unique(),
  casesPerMonth: integer("cases_per_month").notNull(),
  priceMonthlyUsd: integer("price_monthly_usd").notNull(),
  features: jsonb("features").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});
```

Add export type: `export type PlanRow = InferSelectModel<typeof plans>;`

### A.3: StripeBillingClient — Full Implementation

**File:** `src/services/billing/stripe.ts` — replace current no-op with full implementation.

Key additions to existing skeleton:
- `createCheckoutSession(tenantId, priceId, successUrl, cancelUrl)` → returns Stripe Checkout URL
- `createCustomerPortalSession(tenantId, returnUrl)` → returns Stripe Customer Portal URL
- `getSubscription(stripeSubscriptionId)` → returns current subscription state
- `cancelSubscription(stripeSubscriptionId)` → marks for cancellation at period end
- Fix `recordUsage(tenantId, quantity)` → calls `stripe.subscriptionItems.createUsageRecord()`

**Pattern for each method:**
1. Guard: `if (this.stripe === null) return null` (fail-soft, zero-key compatible)
2. Stripe SDK call
3. try/catch around Stripe SDK → log error, return null (never throw from billing)

### A.4: Stripe Webhook Handler

**Create:** `src/api/routes/stripe-webhook.ts`

```ts
// POST /stripe/webhook — PUBLIC (no auth middleware)
// 1. Read raw body (c.req.text())
// 2. Verify signature: stripe.webhooks.constructEvent(body, sigHeader, env.STRIPE_WEBHOOK_SECRET)
// 3. Switch on event.type:
//    - checkout.session.completed → activate subscription
//    - customer.subscription.updated → sync status/plan/price
//    - customer.subscription.deleted → set inactive
//    - invoice.paid → log, update usage if metered
//    - invoice.payment_failed → set past_due
// 4. Idempotency: INSERT audit_log with stripeEventId; ON CONFLICT DO NOTHING
// 5. Return 200 {received: true}
```

**Mount** in `src/api/index.ts` BEFORE auth middleware:
```ts
import { stripeWebhookRoutes } from "./routes/stripe-webhook.js";
app.route("/", stripeWebhookRoutes); // BEFORE auth middleware
```

### A.5: Plan Enforcement Middleware

**Create:** `src/api/middleware/plan-gate.ts`

Two exports:
- `getPlanLimits(tenantId)` → `{ casesPerMonth, features[] }` — fetches from plans table
- `requirePlanGate("cases")` → middleware — checks current usage ≤ plan limit, returns 402 with `{upgradeUrl, limit, current}` if exceeded

**Apply** in `src/api/index.ts`:
```ts
import { requirePlanGate } from "./middleware/plan-gate.js";
// After auth + rateLimit middleware for /cases:
app.use("/cases", authMiddleware, rateLimit("api"), requirePlanGate("cases"));
```

### A.6: Fix Usage API — Real 6-Month History

**File:** `src/api/routes/usage.ts` — replace `sixMonthHistory: [summary]` with:

```ts
// Query usage table for last 6 months
// SELECT * FROM usage WHERE tenant_id = $1 AND month >= $2 ORDER BY month DESC
// Fill gaps with zero rows for months with no activity
```

### A.7: Env Config Update

**File:** `src/config/env.ts` — add:
```ts
STRIPE_SECRET_KEY: str({ default: "" }),
STRIPE_WEBHOOK_SECRET: str({ default: "" }),
STRIPE_PRICE_STARTER: str({ default: "" }),
STRIPE_PRICE_GROWTH: str({ default: "" }),
STRIPE_PRICE_ENTERPRISE: str({ default: "" }),
APP_BASE_URL: url({ default: "http://localhost:3000" }),
REPORT_SIGNING_KEY: str({ default: "" }),
```

### A.8: Error Handling — Phase A

| Failure mode | Where caught | Behavior |
|---|---|---|
| Stripe API down | `StripeBillingClient` methods | Log error, return null (never throw) |
| Webhook signature mismatch | `stripe-webhook.ts` | `400 Bad Request` — discard, Stripe retries |
| Duplicate webhook event | Idempotency by `stripeEventId` | 200, no-op |
| Plan quota exceeded | `plan-gate.ts` middleware | `402 Payment Required` + `{upgradeUrl, limit, current}` |
| Missing Stripe keys (dev) | `StripeBillingClient` constructor | `this.stripe = null` → all methods return null |

### A.9: Verification — Phase A

```bash
npm run typecheck && npm run test     # ✅ green
```
```bash
# Stripe Checkout:
curl -X POST http://localhost:3000/billing/checkout \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"priceId":"price_starter"}'
# → Returns Stripe Checkout URL → open → complete test payment
# → Check DB: tenants.subscription_status = "active"

# Simulate webhook:
stripe trigger checkout.session.completed
# → Server log: "subscription activated for ten_..."

# Plan gate test: set tenant to starter, create 51 cases → 402 on 51st
```

---

## 5. Phase B — Auth & Signup UI

*Files: `public/login.html` (new), `public/signup.html` (new), `public/forgot-password.html` (new), `public/reset-password.html` (new), `public/app.html`, `src/api/routes/auth.ts`, `src/api/index.ts`, `src/db/migrations/0003_password_reset.sql` (new)*

### B.1: Login Page

**Create:** `public/login.html`

- Dark theme matching brand (cinematic dark, electric blue accents)
- Email + password form → `POST /auth/login` → store tokens in `localStorage` → redirect to `/app`
- Error display: "Invalid email or password" (generic — don't leak which is wrong)
- Links: "Don't have an account? Start free trial" → `/signup`, "Forgot password?" → `/forgot-password`
- No external dependencies (ADR-006)

### B.2: Signup Page

**Create:** `public/signup.html`

- Company name, email, password (min 12 chars), plan selector (3 cards)
- Submit → `POST /provision` → get `{tenantId, apiKey, userId}` → redirect to Stripe Checkout
- Stripe success → `/app?welcome=1`, cancel → `/signup?cancelled=1`

### B.3: Forgot Password Flow

**Create:** `public/forgot-password.html`, `public/reset-password.html`

**New API endpoints** in `src/api/routes/auth.ts`:
- `POST /auth/forgot-password` → generate reset JWT (1h), store hash in DB, send email (stub: console.log in dev), always return 200
- `POST /auth/reset-password` → verify JWT, update password, clear reset token

**Migration:** `src/db/migrations/0003_password_reset.sql`
```sql
ALTER TABLE users ADD COLUMN reset_token_hash TEXT;
ALTER TABLE users ADD COLUMN reset_token_expires_at TIMESTAMPTZ;
```

### B.4: Auth Protection for Dashboard

**File:** `public/app.html` — replace hardcoded `API_KEY`:

```js
// OLD (line ~506):
// const API_KEY = "kc_live_demo0000000000000000000000";

// NEW — Auth module (inline in <script>):
const Auth = {
  getToken() { return localStorage.getItem('accessToken'); },
  setTokens(access, refresh) {
    localStorage.setItem('accessToken', access);
    localStorage.setItem('refreshToken', refresh);
  },
  clearTokens() {
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
  },
  isLoggedIn() {
    const t = this.getToken();
    if (!t) return false;
    try {
      const p = JSON.parse(atob(t.split('.')[1]));
      return p.exp * 1000 > Date.now();
    } catch { return false; }
  },
  getUser() {
    try { return JSON.parse(atob(this.getToken().split('.')[1])); }
    catch { return null; }
  },
  async refresh() {
    const rt = localStorage.getItem('refreshToken');
    if (!rt) { this.clearTokens(); return false; }
    const r = await fetch('/auth/refresh', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({refreshToken: rt})
    });
    if (!r.ok) { this.clearTokens(); return false; }
    const j = await r.json();
    this.setTokens(j.accessToken, j.refreshToken);
    return true;
  },
  async fetch(url, opts = {}) {
    opts.headers = {...opts.headers, 'Authorization': `Bearer ${this.getToken()}`};
    let r = await fetch(url, opts);
    if (r.status === 401) {
      const ok = await this.refresh();
      if (ok) {
        opts.headers.Authorization = `Bearer ${this.getToken()}`;
        r = await fetch(url, opts);
      }
    }
    if (r.status === 401) {
      this.clearTokens();
      window.location.href = '/login.html';
    }
    return r;
  }
};

// On page load:
if (!Auth.isLoggedIn()) { window.location.href = '/login.html'; }
const user = Auth.getUser();
// Replace "JD" avatar with user email initial
// Replace ALL fetch() calls with Auth.fetch()
// Add logout button → Auth.clearTokens() → redirect to /login.html
```

### B.5: Mount Static Routes

**File:** `src/api/index.ts` — add:
```ts
app.get("/login", (c) => c.html(readFileSync(resolve(process.cwd(), "public", "login.html"), "utf8")));
app.get("/signup", (c) => c.html(readFileSync(resolve(process.cwd(), "public", "signup.html"), "utf8")));
app.get("/forgot-password", (c) => c.html(readFileSync(resolve(process.cwd(), "public", "forgot-password.html"), "utf8")));
```

### B.6: Error Handling — Phase B

| Failure mode | Where caught | Behavior |
|---|---|---|
| Invalid credentials | `POST /auth/login` | `401` — rate-limited (10/min) |
| Expired token | `Auth.fetch()` interceptor | Silent refresh; redirect to login on failure |
| Existing email on signup | `POST /provision` | `409 Conflict` |
| Stripe Checkout cancelled | Redirect to `/signup?cancelled=1` | "Setup incomplete" message |

### B.7: Verification — Phase B

```bash
npm run typecheck && npm run test     # ✅ green
```
```bash
# Open /login.html → log in as admin@example.test / ChangeMe-123456
# → Redirect to /app, dashboard loads with user email in header
# → Hardcoded kc_live_demo key is GONE from app.html

# Open /signup.html → create account → Stripe Checkout → /app?welcome=1
# Logout → redirected to /login.html
# Try /app without login → redirected to /login.html
```

---

## 6. Phase C — Case Management Dashboard

*Files: `public/app.html`, `src/api/routes/cases.ts`*

### C.1: Search & Filter API

**File:** `src/api/routes/cases.ts` — extend `GET /cases` with query params:

```
GET /cases?search=Acme&status=completed&risk=Low&sort=createdAt&order=desc&offset=0&limit=20
```

Implementation:
- Build WHERE clauses dynamically: `ilike(companyNameMask, '%search%')`, `eq(status)`, `eq(riskScore)`
- ORDER BY mapped column (createdAt, companyNameMask, riskScore)
- Second query for COUNT(*) → set `X-Total-Count` response header
- Return paginated results with `X-Page-Size` header

### C.2: Case List UI — Search, Filter, Pagination

**File:** `public/app.html` — extend existing case list:

- **Search input:** `oninput` with 300ms debounce → `loadCases()`
- **Status filter:** dropdown (All / Processing / Pending HITL / Completed / Failed)
- **Risk filter:** dropdown (All / Low / Medium / High)
- **Pagination:** Previous/Next buttons + "Showing X–Y of Z"
- **Sort:** clickable column headers, toggle asc/desc

```js
let currentPage = 0, pageSize = 20;
let currentFilters = {};

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

const loadCases = debounce(async () => {
  showSkeletons();
  const params = new URLSearchParams({
    offset: currentPage * pageSize, limit: pageSize, ...currentFilters
  });
  const r = await Auth.fetch(`/cases?${params}`);
  const total = parseInt(r.headers.get('X-Total-Count') || '0');
  const cases = await r.json();
  renderCaseTable(cases);
  renderPagination(total);
}, 300);
```

### C.3: Case Detail Panel

**File:** `public/app.html` — add slide-in detail panel (replaces toast-only viewCase):

```html
<div id="case-detail" class="detail-panel hidden">
  <div class="detail-header">
    <h2 id="detail-company">...</h2>
    <button onclick="closeDetail()" class="close-btn">&times;</button>
  </div>
  <div class="detail-body">
    <div class="detail-meta"><!-- company info, status, risk --></div>
    <div class="detail-dossier"><!-- dossier preview --></div>
    <div class="detail-evidence"><!-- evidence count + keys --></div>
    <div class="detail-audit"><!-- audit log entries --></div>
    <div class="detail-actions">
      <button onclick="downloadReport('pdf')">Download PDF</button>
      <button onclick="downloadReport('json')">Download JSON</button>
      <button onclick="exportCase()">Export (GDPR)</button>
      <button id="detail-approve" class="approve-btn hidden" onclick="approveFromDetail()">Approve</button>
    </div>
  </div>
</div>
```

### C.4: Error Handling — Phase C

| Failure mode | Where caught | Behavior |
|---|---|---|
| Search returns no results | Dashboard JS | Empty state: "No cases match. [Clear filters]" |
| Pagination beyond range | API | Empty array + correct `X-Total-Count` |

### C.5: Verification — Phase C

```bash
npm run typecheck && npm run test     # ✅ green
```
```bash
# Search "Acme" → only Acme cases
# Filter "Completed" → only completed
# Click page 2 → "Showing 21–40 of X"
# Click "View" → detail panel with Download buttons
# Click "Download PDF" → browser downloads file
```

---

## 7. Phase D — Billing & Team Dashboard Views

*Files: `public/app.html`, `src/api/routes/billing.ts` (new), `src/api/routes/users.ts` (new), `src/api/routes/tenants.ts`*

### D.1: Billing API

**Create:** `src/api/routes/billing.ts`

```ts
// GET /billing → auth middleware
// Returns: {plan, subscriptionStatus, casesPerMonth, priceMonthlyUsd,
//           casesUsedThisMonth, invoices: [{date,amount,status,pdfUrl}],
//           nextBillingDate, trialEndsAt}

// POST /billing/portal → returns {url: "https://billing.stripe.com/..."}
```

Mount in `src/api/index.ts`:
```ts
import { billingRoutes } from "./routes/billing.js";
app.route("/", billingRoutes);
```

### D.2: Users API

**Create:** `src/api/routes/users.ts`

```ts
// GET /users → admin only → list users: {id, email, role, lastLoginAt, createdAt}
// POST /users/invite → admin only → {email, role} → create user, send invite (stub: console.log in dev)
// PATCH /users/:id/role → admin only, cannot change own role
// DELETE /users/:id → admin only, cannot delete self (soft-delete via deletedAt)
```

Mount in `src/api/index.ts`:
```ts
import { userRoutes } from "./routes/users.js";
app.route("/", userRoutes);
```

### D.3: Fix Tenant Usage Route

**File:** `src/api/routes/tenants.ts` — fix `GET /tenants/:id/usage` stub:
```ts
// Query usage table for last 6 months for the tenant
// Return: [{month, casesProcessed, apiCalls, costUsd}]
```

### D.4: Billing Dashboard Page

**File:** `public/app.html` — add Billing tab content:

- Current plan badge + price
- Usage progress bar (cases used / plan limit), amber warning at ≥90%
- ROI summary: € cost avoided + hours saved
- Invoice history (last 12 from Stripe)
- "Manage Subscription" button → Stripe Customer Portal

### D.5: Team Dashboard Page

**File:** `public/app.html` — add Team tab content:

- Team member table (email, role, last active)
- "Invite Member" button → modal with email + role
- Role change dropdown (admin only)
- Remove button (admin only, not self)

### D.6: Error Handling — Phase D

| Failure mode | Where caught | Behavior |
|---|---|---|
| Stripe Customer Portal fails | `POST /billing/portal` | `502` + retry message |
| Invite email fails (Resend down) | `POST /users/invite` | User created anyway; show manual invite link |
| Admin tries to delete self | `DELETE /users/:id` | `403` |

### D.7: Verification — Phase D

```bash
npm run typecheck && npm run test     # ✅ green
```
```bash
# Billing tab: plan badge, usage bar, ROI, invoices
# Usage ≥90%: amber bar + "Upgrade →" prompt (Trigger 🔔1)
# "Manage Subscription" → Stripe Customer Portal
# Team tab: member list, invite flow, role change
# Try removing self → 403 error toast
```

---

## 8. Phase E — Audit-Grade Reports

*Files: `src/services/reports/signer.ts` (new), `src/services/reports/pdf-renderer.ts`, `src/services/reports/generator.ts`, `src/api/routes/cases.ts`*

### E.1: Content-Integrity Signer

**Create:** `src/services/reports/signer.ts`

```ts
import { createHmac, createHash } from "node:crypto";
import { env } from "../../config/env.js";

export interface ReportSignature {
  algorithm: "HMAC-SHA256";
  signature: string;          // base64
  keyFingerprint: string;     // SHA-256 of signing key, first 16 hex chars
  canonicalFields: string[];  // ordered fields in the hash
  verificationHint: string;   // human-readable verification instruction
}

export function signReport(report: { reportId: string; caseId: string;
  tenantId: string; generatedAt: string; dossier: string;
  evidenceChain: unknown; auditTrail: unknown }): ReportSignature {

  const key = env.REPORT_SIGNING_KEY ?? "";
  const canonical = [
    report.reportId, report.caseId, report.tenantId,
    report.generatedAt, report.dossier,
    JSON.stringify(report.evidenceChain),
    JSON.stringify(report.auditTrail)
  ].join("\n");
  const contentHash = createHash("sha256").update(canonical).digest("hex");

  if (key.length === 0) {
    return {
      algorithm: "HMAC-SHA256",
      signature: `unsigned:${contentHash}`,
      keyFingerprint: "no-signing-key-configured",
      canonicalFields: ["reportId","caseId","tenantId","generatedAt","dossier","evidenceChain","auditTrail"],
      verificationHint: "No signing key configured. Content hash: " + contentHash
    };
  }

  const sig = createHmac("sha256", key).update(contentHash).digest("base64");
  const fp = createHash("sha256").update(key).digest("hex").slice(0, 16);

  return {
    algorithm: "HMAC-SHA256",
    signature: sig,
    keyFingerprint: fp,
    canonicalFields: ["reportId","caseId","tenantId","generatedAt","dossier","evidenceChain","auditTrail"],
    verificationHint: `Verify with: echo -n '<content-hash>' | openssl dgst -sha256 -hmac '<key>'`
  };
}

export function verifyReportSignature(
  report: Parameters<typeof signReport>[0],
  signature: ReportSignature
): boolean {
  const recomputed = signReport(report);
  return recomputed.signature === signature.signature
    && recomputed.keyFingerprint === signature.keyFingerprint;
}
```

### E.2: Update PDF Renderer

**File:** `src/services/reports/pdf-renderer.ts` — replace `"PKCS#7 signature placeholder: ${report.digitalSignatureBlock}"` with:

```html
<div class="signature-block">
  <h4>Report Integrity Verification</h4>
  <div class="sig-detail">
    <span>Algorithm: ${report.signature.algorithm}</span>
    <span>Signature: ${report.signature.signature}</span>
    <span>Key Fingerprint: ${report.signature.keyFingerprint}</span>
  </div>
  <div class="sig-fields">
    <span>Canonical fields: ${report.signature.canonicalFields.join(', ')}</span>
  </div>
  <div class="sig-verify">
    <p>To verify this report, compute SHA-256 of the canonical fields
       and verify against the signature above using the published key.</p>
    <code>${report.signature.verificationHint}</code>
  </div>
</div>
```

Add page numbers footer:
```html
<div class="page-footer">Page <span class="pageNumber"></span> of <span class="totalPages"></span> | KYC Copilot v1.0.0 | Confidential</div>
```

### E.3: Update Report Generator

**File:** `src/services/reports/generator.ts` — replace `digitalSignatureBlock: sha256Hex(...)` with:

```ts
import { signReport } from "./signer.js";
// ...
const signature = signReport({
  reportId, caseId, tenantId, generatedAt: nowIso(),
  dossier: c.dossier, evidenceChain: evidenceRows, auditTrail: auditRows
});
return {
  // ... all existing fields
  signature, // replaces digitalSignatureBlock
};
```

### E.4: Verification Endpoint

**File:** `src/api/routes/cases.ts` — add:
```ts
// POST /cases/:id/report/verify
// Recomputes signature, compares with stored, returns {valid, computedSignature, storedSignature}
```

### E.5: Verification — Phase E

```bash
npm run typecheck && npm run test     # ✅ green
```
```bash
# Download PDF → scroll to last page
# → "Report Integrity Verification" block with:
#   Algorithm: HMAC-SHA256, Signature: <base64>, Key Fingerprint: <hex>
# → NO "PKCS#7 signature placeholder" text
# POST /cases/:id/report/verify → {valid: true}
```

---

## 9. Phase F — Landing Page & Trial Flow

*Files: `public/landing.html`, `public/signup.html`, `public/app.html`*

### F.1: Landing Page Overhaul

**File:** `public/landing.html`

Changes:
1. **Hero CTA:** `href="/app"` → `href="/signup"`
2. **Secondary CTA:** "See how it works" → scrolls to demo section
3. **Pricing section** (extend/complete if truncated):
   - 3 plan cards: Starter (€99/mo), Growth (€499/mo), Enterprise (Custom)
   - Each with feature list + "Start Free Trial" button
4. **ROI calculator:** Complete the JS — on input change, compute `cases * €380` savings + `cases * 3.27` analyst hours saved
5. **Compliance badges:** "AMLD6-aligned", "GDPR-ready", "AES-256-GCM encryption"

### F.2: Trial Signup Flow

**File:** `public/signup.html` — extend:
1. URL param `?plan=starter` → pre-selects plan
2. After `POST /provision` → `POST /billing/checkout` with `trial_period_days: 14`
3. Stripe success → `/app?welcome=1`, cancel → `/signup?cancelled=1`

### F.3: Guided Onboarding Modal

**File:** `public/app.html` — show when `?welcome=1` in URL:

```html
<div id="welcome-modal" class="modal">
  <h2>Welcome to KYC Copilot 🎉</h2>
  <p>Your account is ready. Let's run your first compliance check.</p>
  <div class="onboarding-demo">
    <p>Try it with a test company:</p>
    <div class="prefilled-form">
      <input value="Acme Logistics BV" disabled>
      <input value="NL12345678" disabled>
      <select disabled><option>Netherlands (NL)</option></select>
    </div>
    <button onclick="runDemoCase()" class="cta">
      Run Your First Check (14 seconds)
    </button>
  </div>
  <button onclick="closeWelcome()" class="text-btn">
    Skip — I'll explore on my own
  </button>
</div>
```

JS: `runDemoCase()` → `POST /cases?sync=true` with pre-filled Acme data → on `completed` → show ceremony + toast → close modal.

### F.4: Verification — Phase F

```bash
npm run typecheck && npm run test     # ✅ green
```
```bash
# Landing page → "Start Free Trial" → /signup
# ROI calculator: type "100" → shows "Save €38,000/month"
# Signup Starter plan → Stripe Checkout (trial, €0 now)
# /app?welcome=1 → onboarding modal
# "Run Your First Check" → 14 seconds → ceremony → dashboard
```

---

## 10. Phase G — Production Hardening

*Files: `tests/e2e/kyc-lifecycle.test.ts`, `tests/integration/api/cases.test.ts`, `vitest.config.ts`, `docker-compose.yml`*

### G.1: Real E2E Test

**File:** `tests/e2e/kyc-lifecycle.test.ts` — replace `toHaveLength(5)` placeholder with full lifecycle:

```
provision → login → create case (sync, low-risk) → verify completed + dossier + evidence
→ create high-risk case → verify pending_hitl → approve → verify completed
→ download report → verify report structure + signature
→ erase case (GDPR) → verify 404
```

Runs against docker-compose stack (real Postgres + Redis, no mocks).

### G.2: API Contract Tests

**File:** `tests/integration/api/cases.test.ts` — replace placeholder with:
- Shape validation for every endpoint (Zod parse response)
- Error shape validation (400, 401, 402, 403, 404, 409)

### G.3: Coverage Thresholds

**File:** `vitest.config.ts` — update:
```ts
coverage: {
  thresholds: {
    lines: 60,
    branches: 40,
    functions: 55,
    statements: 60,
  }
}
```

### G.4: Docker Compose Test Service

**File:** `docker-compose.yml` — add:
```yaml
test:
  build: .
  depends_on:
    db:
      condition: service_healthy
    redis:
      condition: service_healthy
  environment:
    - DATABASE_URL=postgres://kyc:kyc@db:5432/kyc
    - REDIS_URL=redis://redis:6379
    - NODE_ENV=test
    - LLM_TIER_PRIMARY=t0
  command: npm run test
```

### G.5: Verification — Phase G

```bash
npm run typecheck                 # ✅ green
npm run test                      # ✅ all pass, coverage ≥60% lines
npm run build                     # ✅
docker build .                    # ✅
docker compose run --rm test      # ✅ all pass against real PG/Redis
```

---

## 11. Customer Triggers — Behavioral Moments

These are UX moments that signal product quality. Implement alongside phases.

| # | Trigger | When it fires | Phase | Implementation |
|---|---|---|---|---|
| 🔔1 | **Quota warning** | Case usage ≥90% of plan limit | D | Progress bar amber; toast: "45/50 cases used. [Upgrade →]" |
| 🔔2 | **Quota exceeded** | Create case at limit | A | `402` + "Case limit reached. [Upgrade →]" |
| 🔔3 | **First case ceremony** | New signup completes first case | F | Green checkmark + confetti + "Your first dossier is ready! 🎉" |
| 🔔4 | **HITL reminder** | `pending_hitl` unapproved for 24h+ | D | Nav badge: "3 cases awaiting review" (red after 48h) |
| 🔔5 | **Subscription at risk** | `invoice.payment_failed` webhook | A | Banner: "Payment method needs attention. [Update →]" |
| 🔔6 | **Trial expiring** | Trial ends in ≤3 days | A | Banner + countdown: "Trial ends in 2 days. [Add payment →]" |
| 🔔7 | **Invite accepted** | Team member first login | B | Admin toast: "Jane logged in for the first time" |
| 🔔8 | **Empty state** | New tenant, zero cases | C | Illustration + "Run your first check in 14 seconds" + demo button |
| 🔔9 | **Report downloaded** | First report download | C | Toast: "Report downloaded. Evidence chain is verifiable." |
| 🔔10 | **LLM tier escalation** | Case used T3/T4 LLM | — | "AI-Enhanced" badge on case row (subtle blue) |

---

## 12. Edge Cases Table (Cross-Phase)

| Edge case | Phase | Handling |
|---|---|---|
| User signs up with existing email | B | `409 Conflict` — "Account exists. [Log in →]" |
| Stripe webhook delayed after checkout | A | Poll subscription status on dashboard load; "Activating..." spinner |
| Payment fails (invoice.payment_failed) | A | `subscriptionStatus: "past_due"` → `402` with "Update payment →" |
| Cancels mid-cycle | A | Service until period end; `cancelAtPeriodEnd: true` |
| Trial expires before payment added | A | `subscriptionStatus: "inactive"` → redirect to billing |
| Dashboard open in two tabs — logout in one | B | Token refresh in other tab fails → silent redirect to login |
| Admin removes own account | D | `403` — "Cannot remove your own account" |
| Case quota exceeded mid-month | A | `402` with `{upgradeUrl, currentUsage, limit}` |
| PDF render while Chromium saturated | E | `PoolTimeoutError` → `503` + "Retry in a moment" |
| `REPORT_SIGNING_KEY` not configured | E | Fall back to unsigned SHA-256; log warning |
| ROI calculator with 0 cases | F | "Enter your monthly volume to see savings" |
| SEO crawlers hitting signup | F | `robots.txt` blocks `/signup.html`, `/app` |

---

## 13. Rollout Sequence

```
Week 1–2:  Phase A (Billing Engine)
           → Stripe checkout works, webhooks sync, plan gate enforced
           → Deploy staging, verify with Stripe test mode

Week 3–4:  Phase B (Auth & Signup)
           → Login/signup/forgot-password live, hardcoded key removed
           → Self-serve tenant creation end-to-end

Week 5–6:  Phase C (Case Dashboard)
           → Search, filter, pagination, detail panel, report downloads
           → HITL approve from detail panel

Week 7–8:  Phase D (Billing & Team)
           → Billing tab (plan, usage, invoices, ROI)
           → Team tab (members, invite, roles)
           → Triggers 🔔1, 🔔4, 🔔5, 🔔6, 🔔7 active

Week 9:    Phase E (Reports)
           → Content-integrity signatures replace placeholder
           → Verification endpoint live

Week 10:   Phase F (Landing & Trial)
           → Landing page pricing + ROI calculator
           → Trial signup + guided onboarding
           → Trigger 🔔3 active

Week 11–12: Phase G (Hardening)
            → E2E test passes against docker-compose
            → Contract tests for all endpoints
            → Coverage ≥60%, docker build green
            → Deploy to production
```

---

## 14. Handoff Block

```markdown
- Repo: /Users/kakashi3lite/kyc-copilot @ main
- Load: docs/CONTEXT_INDEX.md → role IMPLEMENTER → IS-001 →
  docs/PLAN_BUSINESS_MVP_IMPLEMENTATION.md
- Task: Implement Phases A–G in sequence (each leaves repo green);
  wire all 10 customer triggers as you go
- Do NOT change: deterministic.ts, guardrail table (ADR-013),
  ADR-006 (vanilla HTML), INV-001..007, ADR-014 (UBO extraction)
- Decision anchors: D1 (vanilla HTML), D2 (Stripe Checkout),
  D3 (JWT dashboard auth), D4 (self-serve provision),
  D5 (plan middleware), D6 (content-integrity signing)
- Verify each phase: npm run typecheck && npm run test && docker build .
- Phase A gate: Stripe webhook syncs subscription to DB
- Phase B gate: Login/signup works, no hardcoded API key
- Phase C gate: Case search/filter/pagination/detail panel work
- Phase D gate: Billing + Team tabs functional
- Phase E gate: No "PKCS#7 placeholder" in PDF reports
- Phase F gate: Trial signup → first case ceremony completes
- Phase G gate: 60%+ line coverage, E2E lifecycle test passes
```
