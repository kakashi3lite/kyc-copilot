/**
 * index.ts — Production-grade Hono HTTP API
 *
 * Commercial layer stacked on top of the LangGraph engine:
 *   Auth → Usage gate → Graph → Case registry → Webhooks → Response
 *
 * Endpoints:
 *   GET  /              — Marketing / landing page (public/landing.html)
 *   GET  /app           — Product dashboard (public/app.html)
 *   GET  /health        — Liveness probe (unauthenticated)
 *
 *   GET  /dashboard     — Aggregate metrics + recent cases for the dashboard
 *   GET  /usage         — Monthly usage stats + derived ROI metrics
 *
 *   POST /cases         — Start a new KYC case run
 *   GET  /cases         — List cases (filterable, paginated)
 *   GET  /cases/:id     — Get a single case state snapshot
 *   POST /cases/:id/approve   — Resume after HITL sign-off
 *   POST /cases/:id/rescreen  — Trigger ongoing monitoring re-run
 *   GET  /cases/:id/report    — Download AMLD6 compliance report (JSON)
 *
 *   POST /webhooks      — Register a webhook endpoint
 *   GET  /webhooks      — List registered webhooks for tenant
 *
 *   POST /provision     — Create a new tenant + API key (internal / sign-up flow)
 */

import { Hono, type Context } from "hono";
import { cors }        from "hono/cors";
import { serve }       from "@hono/node-server";
import { v4 as uuid }  from "uuid";
import { z }           from "zod";
import * as fsSync     from "node:fs";
import * as pathMod    from "node:path";

import { authenticate, createTenant, getApiKeys, PLAN_CONFIG, DEMO_KEY } from "./auth.js";
import { recordCaseCompleted, recordApiCall, getUsageSummary, getUsageHistory } from "./usage.js";
import { registerCase, updateCase, getCase, listCases, getCaseMetrics } from "./cases.js";
import { generateReport, renderReportAsMarkdown } from "./reports.js";
import { registerWebhook, listWebhooks, dispatch } from "./webhooks.js";
import { compiledGraph, getCaseState, resumeCaseAfterApproval } from "./graph.js";
import type { AgentState, RiskScore } from "./state.js";

// ---------------------------------------------------------------------------
// App bootstrap
// ---------------------------------------------------------------------------

const app  = new Hono();
const PORT = Number(process.env["PORT"] ?? 3000);

app.use("/*", cors());

// ---------------------------------------------------------------------------
// Static pages
//   GET /     → public/landing.html (marketing / brand page)
//   GET /app  → public/app.html     (full product dashboard)
// ---------------------------------------------------------------------------

/** Helper: reads an HTML file from public/ and returns it as an HTML response. */
function servePublic(c: Context, filename: string) {
  const htmlPath = pathMod.resolve(process.cwd(), "public", filename);
  try {
    return c.html(fsSync.readFileSync(htmlPath, "utf-8"));
  } catch {
    return c.text(`${filename} not found — run npm run build or check the public/ directory.`, 404);
  }
}

// Landing / marketing page (no auth required — public-facing)
app.get("/", (c) => servePublic(c, "landing.html"));

// Product dashboard (no auth required at the HTML level — API calls carry keys)
app.get("/app", (c) => servePublic(c, "app.html"));

// ---------------------------------------------------------------------------
// Auth middleware helper
// ---------------------------------------------------------------------------

/**
 * Extracts and validates the API key from the Authorization header.
 * Returns 401 if the key is missing or invalid.
 * Also increments the raw API call counter for billing.
 */
function requireAuth(c: Parameters<Parameters<typeof app.use>[1]>[0]) {
  const tenant = authenticate(c.req.header("Authorization") ?? c.req.header("x-api-key"));
  if (!tenant) return null;
  // Count every authenticated API call for billing telemetry
  recordApiCall(tenant.tenantId);
  return tenant;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

app.get("/health", (c) =>
  c.json({ status: "ok", service: "kyc-copilot", ts: new Date().toISOString() })
);

// ---------------------------------------------------------------------------
// Dashboard aggregate endpoint
// ---------------------------------------------------------------------------

app.get("/dashboard", (c) => {
  const tenant = requireAuth(c);
  if (!tenant) return c.json({ error: "Unauthorized — include Authorization: Bearer <api-key>" }, 401);

  const plan    = PLAN_CONFIG[tenant.plan];
  const metrics = getCaseMetrics(tenant.tenantId);
  const usage   = getUsageSummary(tenant.tenantId, plan.priceMonthly, tenant.monthlyLimit);
  const { cases } = listCases(tenant.tenantId, { limit: 20 });

  return c.json({
    tenant: {
      name:    tenant.name,
      plan:    tenant.plan,
      planDisplayName: plan.displayName,
      monthlyLimit:    tenant.monthlyLimit,
    },
    metrics,
    usage: {
      month:           usage.month,
      casesProcessed:  usage.casesProcessed,
      utilizationPct:  usage.metrics.utilizationPct,
      manualCostAvoided: usage.metrics.manualCostAvoided,
      timeSavedHours:  usage.metrics.timeSavedHours,
      riskDistribution: usage.riskDistribution,
    },
    recentCases: cases.map(serializeCase),
  });
});

// ---------------------------------------------------------------------------
// Usage stats
// ---------------------------------------------------------------------------

app.get("/usage", (c) => {
  const tenant = requireAuth(c);
  if (!tenant) return c.json({ error: "Unauthorized" }, 401);

  const plan    = PLAN_CONFIG[tenant.plan];
  const current = getUsageSummary(tenant.tenantId, plan.priceMonthly, tenant.monthlyLimit);
  const history = getUsageHistory(tenant.tenantId);

  return c.json({ current, history });
});

// ---------------------------------------------------------------------------
// Cases — create
// ---------------------------------------------------------------------------

const CreateCaseSchema = z.object({
  companyName:        z.string().min(1),
  registrationNumber: z.string().min(1),
  jurisdiction:       z.string().length(2).toUpperCase(),
});

app.post("/cases", async (c) => {
  const tenant = requireAuth(c);
  if (!tenant) return c.json({ error: "Unauthorized" }, 401);

  // Enforce monthly case limit before starting a run
  const plan  = PLAN_CONFIG[tenant.plan];
  const usage = getUsageSummary(tenant.tenantId, plan.priceMonthly, tenant.monthlyLimit);
  if (usage.casesProcessed >= tenant.monthlyLimit) {
    return c.json(
      { error: `Monthly case limit reached (${tenant.monthlyLimit} cases on ${plan.displayName} plan). Upgrade to continue.` },
      429
    );
  }

  const raw    = await c.req.json().catch(() => ({}));
  const parsed = CreateCaseSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.flatten() }, 400);
  }

  const { companyName, registrationNumber, jurisdiction } = parsed.data;
  const caseId = uuid();

  // Register in case store (so dashboard shows it immediately in "processing")
  registerCase(caseId, tenant.tenantId, companyName, registrationNumber, jurisdiction);

  console.log(`[POST /cases] tenant=${tenant.tenantId} case=${caseId} company="${companyName}"`);

  const initialState: Partial<AgentState> = {
    caseId, companyName, registrationNumber, jurisdiction,
    apiData: null, browserData: null, evidenceLedger: {},
    draftDossier: "", riskScore: "Pending",
    requiresHuman: false, messages: [],
  };

  try {
    await compiledGraph.invoke(initialState as AgentState, {
      configurable: { thread_id: caseId },
    });

    const snapshot = await getCaseState(caseId);
    const state    = snapshot?.values as Partial<AgentState>;

    const status: import("./cases.js").CaseStatus =
      snapshot?.next?.includes("humanReviewNode") ? "pending_hitl" : "completed";

    // Sync to case registry
    updateCase(caseId, {
      riskScore:      state.riskScore ?? "Pending",
      status,
      requiresHuman:  state.requiresHuman ?? false,
      draftDossier:   state.draftDossier ?? "",
      evidenceLedger: state.evidenceLedger ?? {},
    });

    // Record usage for billing
    if (status === "completed") {
      recordCaseCompleted(tenant.tenantId, state.riskScore ?? "Pending", false);
    }

    // Dispatch webhook
    dispatch(tenant.tenantId,
      status === "pending_hitl" ? "case.pending_hitl" : "case.completed",
      caseId,
      { companyName, jurisdiction, riskScore: state.riskScore, status }
    );

    return c.json({ caseId, status, snapshot: serializeSnapshot(snapshot) }, 201);
  } catch (err) {
    updateCase(caseId, { status: "error" });
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[POST /cases] Error: ${msg}`);
    return c.json({ error: "Case processing failed", details: msg }, 500);
  }
});

// ---------------------------------------------------------------------------
// Cases — list
// ---------------------------------------------------------------------------

app.get("/cases", (c) => {
  const tenant = requireAuth(c);
  if (!tenant) return c.json({ error: "Unauthorized" }, 401);

  const q       = c.req.query();
  const status  = q["status"] as import("./cases.js").CaseStatus | undefined;
  const risk    = q["riskScore"] as "Low" | "Medium" | "High" | undefined;
  const limit   = Math.min(Number(q["limit"] ?? 50), 100);
  const offset  = Number(q["offset"] ?? 0);

  const { cases, total } = listCases(tenant.tenantId, { status, riskScore: risk, limit, offset });

  return c.json({ cases: cases.map(serializeCase), total, limit, offset });
});

// ---------------------------------------------------------------------------
// Cases — get single
// ---------------------------------------------------------------------------

app.get("/cases/:id", async (c) => {
  const tenant = requireAuth(c);
  if (!tenant) return c.json({ error: "Unauthorized" }, 401);

  const caseId  = c.req.param("id");
  const cas     = getCase(caseId);
  if (!cas || cas.tenantId !== tenant.tenantId) {
    return c.json({ error: "Case not found" }, 404);
  }

  // Also pull fresh graph state
  const snapshot = await getCaseState(caseId).catch(() => null);

  return c.json({ case: serializeCase(cas), snapshot: snapshot ? serializeSnapshot(snapshot) : null });
});

// ---------------------------------------------------------------------------
// Cases — HITL approve
// ---------------------------------------------------------------------------

const ApproveSchema = z.object({
  riskScore:     z.enum(["Low", "Medium", "High"]).optional(),
  reviewerNotes: z.string().optional(),
});

app.post("/cases/:id/approve", async (c) => {
  const tenant = requireAuth(c);
  if (!tenant) return c.json({ error: "Unauthorized" }, 401);

  const caseId = c.req.param("id");
  const cas    = getCase(caseId);
  if (!cas || cas.tenantId !== tenant.tenantId) return c.json({ error: "Case not found" }, 404);
  if (cas.status !== "pending_hitl") {
    return c.json({ error: `Case is not awaiting human review (status: ${cas.status})` }, 409);
  }

  const raw    = await c.req.json().catch(() => ({}));
  const parsed = ApproveSchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);

  const overrides: Partial<AgentState> | null = parsed.data.riskScore
    ? { riskScore: parsed.data.riskScore as RiskScore }
    : null;

  try {
    await resumeCaseAfterApproval(caseId, overrides);

    const finalRisk = parsed.data.riskScore ?? cas.riskScore;
    updateCase(caseId, {
      status:        "completed",
      riskScore:     finalRisk as RiskScore,
      reviewerNotes: parsed.data.reviewerNotes ?? null,
    });

    recordCaseCompleted(tenant.tenantId, finalRisk as RiskScore, true);
    dispatch(tenant.tenantId, "case.approved", caseId,
      { riskScore: finalRisk, reviewerNotes: parsed.data.reviewerNotes }
    );

    return c.json({ caseId, status: "completed", riskScore: finalRisk });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: "Resume failed", details: msg }, 500);
  }
});

// ---------------------------------------------------------------------------
// Cases — compliance report download
// ---------------------------------------------------------------------------

app.get("/cases/:id/report", (c) => {
  const tenant = requireAuth(c);
  if (!tenant) return c.json({ error: "Unauthorized" }, 401);

  const caseId  = c.req.param("id");
  const cas     = getCase(caseId);
  if (!cas || cas.tenantId !== tenant.tenantId) return c.json({ error: "Case not found" }, 404);

  const apiKeys   = getApiKeys(tenant.tenantId);
  const keyLabel  = apiKeys[0]?.label ?? "API";
  const fmt       = c.req.query("format") ?? "json";

  const report = generateReport(cas, keyLabel);

  if (fmt === "markdown") {
    return c.text(renderReportAsMarkdown(report), 200, {
      "Content-Type":        "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="KYC-${report.reportId}.md"`,
    });
  }

  return c.json(report, 200);
});

// ---------------------------------------------------------------------------
// Cases — rescreen (ongoing monitoring)
// ---------------------------------------------------------------------------

app.post("/cases/:id/rescreen", async (c) => {
  const tenant = requireAuth(c);
  if (!tenant) return c.json({ error: "Unauthorized" }, 401);

  // Growth / Enterprise feature gate
  if (tenant.plan === "starter") {
    return c.json({ error: "Ongoing re-screening requires Growth plan or above. Upgrade at /settings." }, 402);
  }

  const caseId = c.req.param("id");
  const cas    = getCase(caseId);
  if (!cas || cas.tenantId !== tenant.tenantId) return c.json({ error: "Case not found" }, 404);

  console.log(`[POST /cases/:id/rescreen] Rescreening case=${caseId}`);

  // Re-run the full graph from the top with the same identity fields
  const newCaseId = uuid();
  registerCase(newCaseId, tenant.tenantId, cas.companyName, cas.registrationNumber, cas.jurisdiction);

  const initialState: Partial<AgentState> = {
    caseId: newCaseId,
    companyName:        cas.companyName,
    registrationNumber: cas.registrationNumber,
    jurisdiction:       cas.jurisdiction,
    apiData: null, browserData: null, evidenceLedger: {},
    draftDossier: "", riskScore: "Pending",
    requiresHuman: false, messages: [],
  };

  try {
    await compiledGraph.invoke(initialState as AgentState, {
      configurable: { thread_id: newCaseId },
    });

    const snapshot = await getCaseState(newCaseId);
    const state    = snapshot?.values as Partial<AgentState>;
    const status: import("./cases.js").CaseStatus =
      snapshot?.next?.includes("humanReviewNode") ? "pending_hitl" : "completed";

    updateCase(newCaseId, {
      riskScore:     state.riskScore ?? "Pending",
      status,
      requiresHuman: state.requiresHuman ?? false,
      draftDossier:  state.draftDossier ?? "",
      evidenceLedger: state.evidenceLedger ?? {},
    });

    dispatch(tenant.tenantId, "case.rescreened", newCaseId,
      { originalCaseId: caseId, newRiskScore: state.riskScore }
    );

    return c.json({ originalCaseId: caseId, newCaseId, status, riskScore: state.riskScore });
  } catch (err) {
    updateCase(newCaseId, { status: "error" });
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: "Rescreen failed", details: msg }, 500);
  }
});

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

const WebhookSchema = z.object({
  url:    z.string().url(),
  events: z.array(z.enum(["case.completed", "case.pending_hitl", "case.approved", "case.rescreened"])),
});

app.post("/webhooks", async (c) => {
  const tenant = requireAuth(c);
  if (!tenant) return c.json({ error: "Unauthorized" }, 401);
  if (tenant.plan === "starter") {
    return c.json({ error: "Webhooks require Growth plan or above." }, 402);
  }

  const raw    = await c.req.json().catch(() => ({}));
  const parsed = WebhookSchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);

  const endpoint = registerWebhook(tenant.tenantId, parsed.data.url, parsed.data.events as import("./webhooks.js").WebhookEvent[]);

  // Return the secret only on creation — never again
  return c.json({ endpointId: endpoint.endpointId, secret: endpoint.secret, url: endpoint.url, events: endpoint.events }, 201);
});

app.get("/webhooks", (c) => {
  const tenant = requireAuth(c);
  if (!tenant) return c.json({ error: "Unauthorized" }, 401);
  const endpoints = listWebhooks(tenant.tenantId).map((e) => ({
    endpointId: e.endpointId,
    url:        e.url,
    events:     e.events,
    active:     e.active,
    createdAt:  e.createdAt.toISOString(),
  }));
  return c.json({ endpoints });
});

// ---------------------------------------------------------------------------
// Tenant provisioning (sign-up / internal)
// ---------------------------------------------------------------------------

app.post("/provision", async (c) => {
  const raw    = await c.req.json().catch(() => ({}));
  const schema = z.object({
    name: z.string().min(2),
    plan: z.enum(["starter", "growth", "enterprise"]),
  });
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return c.json({ error: "Invalid body" }, 400);

  const { tenant, apiKey } = createTenant(parsed.data.name, parsed.data.plan);
  return c.json({
    tenantId: tenant.tenantId,
    apiKey:   apiKey.key,   // show only once
    plan:     tenant.plan,
  }, 201);
});

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

function serializeCase(cas: import("./cases.js").CaseRecord) {
  return {
    caseId:             cas.caseId,
    companyName:        cas.companyName,
    registrationNumber: cas.registrationNumber,
    jurisdiction:       cas.jurisdiction,
    riskScore:          cas.riskScore,
    status:             cas.status,
    requiresHuman:      cas.requiresHuman,
    evidenceLedger:     cas.evidenceLedger,
    draftDossier:       cas.draftDossier,
    createdAt:          cas.createdAt.toISOString(),
    updatedAt:          cas.updatedAt.toISOString(),
    completedAt:        cas.completedAt?.toISOString() ?? null,
    reviewerNotes:      cas.reviewerNotes,
  };
}

function serializeSnapshot(snapshot: Awaited<ReturnType<typeof getCaseState>>) {
  if (!snapshot) return null;
  const v = snapshot.values as Partial<AgentState>;
  return {
    caseId:         v.caseId,
    riskScore:      v.riskScore,
    requiresHuman:  v.requiresHuman,
    draftDossier:   v.draftDossier,
    evidenceLedger: v.evidenceLedger,
    messageCount:   v.messages?.length ?? 0,
    nextNodes:      snapshot.next,
  };
}

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

const startBanner = `
  ╔═══════════════════════════════════════════════════╗
  ║      KYC Copilot — Compliance Automation API      ║
  ║      AMLD6 · LangGraph · Evidence Ledger          ║
  ╚═══════════════════════════════════════════════════╝
  Dashboard → http://localhost:${PORT}
  Health    → http://localhost:${PORT}/health
  API Key   → ${DEMO_KEY}
`;

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(startBanner);
  if (!process.env["OPENAI_API_KEY"]) {
    console.warn("  ⚠  OPENAI_API_KEY not set — demo mode only (no live graph runs)\n");
  }
});

export default app;
