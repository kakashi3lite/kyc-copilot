import { boolean, index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";

export const planEnum = pgEnum("plan", ["starter", "growth", "enterprise"]);
export const caseStatusEnum = pgEnum("case_status", ["queued", "processing", "pending_hitl", "completed", "failed", "archived"]);
export const riskScoreEnum = pgEnum("risk_score", ["Low", "Medium", "High", "Pending"]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true })
};

export const tenants = pgTable("tenants", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  plan: planEnum("plan").notNull().default("starter"),
  apiKeyHash: text("api_key_hash").notNull(),
  /**
   * First 16 hex chars of HMAC-SHA256(API_KEY_LOOKUP_SECRET, raw_api_key).
   * Indexable lookup field — turns the auth hot path from O(N) bcrypt
   * iteration into a single O(1) index hit, then O(1) timingSafeEqual
   * on the 32-byte HMAC digest. See src/api/middleware/auth.ts.
   */
  apiKeyId: text("api_key_id"),
  /**
   * "fast" → HMAC-SHA256 in apiKeyHash (preferred, new keys)
   * "bcrypt" → legacy bcrypt hash (still honored during migration)
   * null   → treat as legacy bcrypt
   */
  apiKeyAlgo: text("api_key_algo"),
  webhookSecretEncrypted: text("webhook_secret_encrypted").notNull(),
  llmBudgetUsd: numeric("llm_budget_usd", { precision: 10, scale: 2 }).notNull().default("100.00"),
  stripeCustomerId: text("stripe_customer_id"),
  /** Stripe subscription fields — synced from webhook events (Phase A). */
  stripeSubscriptionId: text("stripe_subscription_id"),
  stripePriceId: text("stripe_price_id"),
  trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
  subscriptionStatus: text("subscription_status").notNull().default("inactive"),
  active: boolean("active").notNull().default(true),
  ...timestamps
}, (table) => ({
  planIdx: index("tenants_plan_idx").on(table.plan),
  createdIdx: index("tenants_created_idx").on(table.createdAt),
  apiKeyIdUnique: uniqueIndex("tenants_api_key_id_unique").on(table.apiKeyId),
  subscriptionIdx: index("tenants_subscription_status_idx").on(table.subscriptionStatus),
  // Partial unique index — webhook lookups by Stripe subscription id.
  stripeSubscriptionUnique: uniqueIndex("tenants_stripe_subscription_unique").on(table.stripeSubscriptionId).where(sql`${table.stripeSubscriptionId} IS NOT NULL`)
}));

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("analyst"),
  refreshTokenHash: text("refresh_token_hash"),
  name: text("name"),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  invitedAt: timestamp("invited_at", { withTimezone: true }),
  inviteAcceptedAt: timestamp("invite_accepted_at", { withTimezone: true }),
  deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
  resetTokenHash: text("reset_token_hash"),
  resetTokenExpiresAt: timestamp("reset_token_expires_at", { withTimezone: true }),
  ...timestamps
}, (table) => ({
  emailUnique: uniqueIndex("users_email_unique").on(table.email),
  tenantIdx: index("users_tenant_idx").on(table.tenantId)
}));

export const cases = pgTable("cases", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  companyNameEncrypted: text("company_name_encrypted").notNull(),
  companyNameMask: text("company_name_mask").notNull(),
  registrationNumberEncrypted: text("registration_number_encrypted").notNull(),
  registrationNumberMask: text("registration_number_mask").notNull(),
  jurisdiction: varchar("jurisdiction", { length: 2 }).notNull(),
  status: caseStatusEnum("status").notNull().default("queued"),
  riskScore: riskScoreEnum("risk_score").notNull().default("Pending"),
  requiresHuman: boolean("requires_human").notNull().default(false),
  uboVerified: boolean("ubo_verified").notNull().default(false),
  browserFailed: boolean("browser_failed").notNull().default(false),
  dossier: text("dossier").notNull().default(""),
  graphState: jsonb("graph_state").$type<Record<string, unknown>>().notNull().default({}),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  ...timestamps
}, (table) => ({
  tenantIdx: index("cases_tenant_id_idx").on(table.tenantId),
  statusIdx: index("cases_status_idx").on(table.status),
  riskIdx: index("cases_risk_score_idx").on(table.riskScore),
  createdIdx: index("cases_created_at_idx").on(table.createdAt)
}));

export const evidence = pgTable("evidence", {
  id: text("id").primaryKey(),
  caseId: text("case_id").notNull().references(() => cases.id, { onDelete: "cascade" }),
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  key: text("key").notNull(),
  sourceUrlEncrypted: text("source_url_encrypted").notNull(),
  sourceUrlMask: text("source_url_mask").notNull(),
  summary: text("summary").notNull(),
  kind: text("kind").notNull(),
  version: integer("version").notNull().default(1),
  previousHash: text("previous_hash"),
  contentHash: text("content_hash").notNull(),
  ...timestamps
}, (table) => ({
  caseIdx: index("evidence_case_id_idx").on(table.caseId),
  tenantIdx: index("evidence_tenant_id_idx").on(table.tenantId),
  keyUnique: uniqueIndex("evidence_case_key_unique").on(table.caseId, table.key)
}));

export const auditLogs = pgTable("audit_logs", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  caseId: text("case_id"),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  oldValue: jsonb("old_value").$type<Record<string, unknown> | null>(),
  newValue: jsonb("new_value").$type<Record<string, unknown> | null>(),
  hash: text("hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  tenantIdx: index("audit_tenant_id_idx").on(table.tenantId),
  caseIdx: index("audit_case_id_idx").on(table.caseId),
  createdIdx: index("audit_created_at_idx").on(table.createdAt)
}));

export const usage = pgTable("usage", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  month: varchar("month", { length: 7 }).notNull(),
  casesProcessed: integer("cases_processed").notNull().default(0),
  promptTokens: integer("prompt_tokens").notNull().default(0),
  completionTokens: integer("completion_tokens").notNull().default(0),
  costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
  apiCalls: integer("api_calls").notNull().default(0),
  /** Stripe metering bookkeeping — set after a usage record is reported. */
  stripeUsageRecordId: text("stripe_usage_record_id"),
  reportedToStripeAt: timestamp("reported_to_stripe_at", { withTimezone: true }),
  ...timestamps
}, (table) => ({
  tenantMonthUnique: uniqueIndex("usage_tenant_month_unique").on(table.tenantId, table.month),
  tenantIdx: index("usage_tenant_id_idx").on(table.tenantId)
}));

export const webhooks = pgTable("webhooks", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  urlEncrypted: text("url_encrypted").notNull(),
  urlMask: text("url_mask").notNull(),
  secretEncrypted: text("secret_encrypted").notNull(),
  events: jsonb("events").$type<string[]>().notNull().default([]),
  active: boolean("active").notNull().default(true),
  ...timestamps
}, (table) => ({
  tenantIdx: index("webhooks_tenant_id_idx").on(table.tenantId)
}));

export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: text("id").primaryKey(),
  webhookId: text("webhook_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  event: text("event").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  attempts: integer("attempts").notNull().default(0),
  status: text("status").notNull().default("pending"),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  lastError: text("last_error"),
  ...timestamps
}, (table) => ({
  tenantIdx: index("deliveries_tenant_id_idx").on(table.tenantId),
  statusIdx: index("deliveries_status_idx").on(table.status)
}));

export const failedCases = pgTable("failed_cases", {
  id: text("id").primaryKey(),
  caseId: text("case_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  reason: text("reason").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => ({ caseIdx: index("failed_cases_case_id_idx").on(table.caseId) }));

export const amld6Articles = pgTable("amld6_articles", {
  id: text("id").primaryKey(),
  article: text("article").notNull(),
  title: text("title").notNull(),
  text: text("text").notNull(),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

/**
 * Plan definitions — single source of truth for plan metadata (quota,
 * pricing, feature flags). Seeded by migration 0002; `id` matches the
 * `plan` enum values on tenants so plan lookups are a single index hit.
 */
export const plans = pgTable("plans", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  casesPerMonth: integer("cases_per_month").notNull(),
  priceMonthlyUsd: integer("price_monthly_usd").notNull(),
  features: jsonb("features").$type<Record<string, boolean | number>>().notNull().default({}),
  stripePriceId: text("stripe_price_id"),
  ...timestamps
});

/**
 * Stripe webhook event log — idempotency key (event id is the PK) plus
 * a full audit trail of every event Stripe delivered to us.
 */
export const stripeEvents = pgTable("stripe_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  tenantId: text("tenant_id").references(() => tenants.id),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  typeIdx: index("stripe_events_type_idx").on(table.type),
  tenantIdx: index("stripe_events_tenant_idx").on(table.tenantId)
}));

export type TenantRow = InferSelectModel<typeof tenants>;
export type UserRow = InferSelectModel<typeof users>;
export type CaseRow = InferSelectModel<typeof cases>;
export type NewCaseRow = InferInsertModel<typeof cases>;
export type EvidenceRow = InferSelectModel<typeof evidence>;
export type WebhookRow = InferSelectModel<typeof webhooks>;
export type PlanRow = InferSelectModel<typeof plans>;
export type StripeEventRow = InferSelectModel<typeof stripeEvents>;
