import { Hono } from "hono";
import { env } from "../../config/env.js";
import { z } from "zod";
import { and, asc, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { db } from "../../db/index.js";
import { auditLogs, cases, evidence } from "../../db/schema.js";
import type { CaseStatus, RiskScore } from "../../types/index.js";
import { graphQueue, runCase } from "../../workers/graph-runner.js";
import { encryptPii, decryptPii } from "../../services/encryption/at-rest.js";
import { generateReport } from "../../services/reports/generator.js";
import { renderPdf } from "../../services/reports/pdf-renderer.js";
import { verifyReportSignature } from "../../services/reports/signer.js";
import { writeAuditLog } from "../../services/audit/logger.js";
import { enqueueWebhookEvent } from "../../services/webhooks/dispatcher.js";
import { maskName, maskRegistration } from "../../utils/mask.js";
import { newId } from "../../utils/id.js";
import { validateJson, getValidated } from "../middleware/validate.js";
import { getAuth } from "../middleware/auth.js";
import { requirePlanLimit } from "../middleware/plan-gate.js";
import { problem } from "../middleware/error-handler.js";

const createCaseSchema = z.object({ companyName: z.string().min(1), registrationNumber: z.string().min(1), jurisdiction: z.string().length(2) });
const approveSchema = z.object({ notes: z.string().default(""), riskOverride: z.enum(["Low", "Medium", "High", "Pending"]).optional() });

export const caseRoutes = new Hono();

// D5 — plan quota enforcement lives in middleware, not scattered checks.
// Only the write paths (create + rescreen) consume quota; reads stay open
// so an over-quota tenant can still view their dashboard.
caseRoutes.post("/cases", requirePlanLimit("cases"), validateJson(createCaseSchema), async (c) => {
  const auth = getAuth(c);
  const body = getValidated<z.infer<typeof createCaseSchema>>(c);
  const caseId = newId("case");
  await db.insert(cases).values({ id: caseId, tenantId: auth.tenantId, companyNameEncrypted: encryptPii(body.companyName), companyNameMask: maskName(body.companyName), registrationNumberEncrypted: encryptPii(body.registrationNumber), registrationNumberMask: maskRegistration(body.registrationNumber), jurisdiction: body.jurisdiction.toUpperCase(), status: "queued" });
  await writeAuditLog({ tenantId: auth.tenantId, caseId, actor: auth.userId ?? "api", action: "case.created", newValue: { jurisdiction: body.jurisdiction.toUpperCase() } });
  if (c.req.query("sync") === "true") {
    const syncAllowed = env.LLM_SYNC_ALLOWED_TIERS.split(",").map((t: string) => t.trim());
    if (!syncAllowed.includes(env.LLM_TIER_PRIMARY)) {
      return problem(c, 400, "Bad Request", "Sync not allowed for heavy LLM tiers. Poll /cases/:id");
    }
    await runCase(caseId, auth.tenantId);
    // Re-read after the inline run so the sync response reflects the real
    // terminal status (completed / pending_hitl / failed), not a hardcoded
    // "queued".
    const synced = await db.select().from(cases).where(eq(cases.id, caseId)).limit(1);
    const syncedRow = synced[0];
    return c.json({ caseId, status: syncedRow?.status ?? "queued" }, syncedRow?.status === "completed" ? 200 : 201);
  } else {
    await graphQueue.add("run" as const, { caseId, tenantId: auth.tenantId });
  }
  return c.json({ caseId, status: "queued" }, 201);
});

caseRoutes.get("/cases", async (c) => {
  const auth = getAuth(c);

  // ── Search / filter / sort / pagination (Phase C) ───────────────────────
  const num = (v: string | undefined, d: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const conditions: SQL[] = [eq(cases.tenantId, auth.tenantId), isNull(cases.deletedAt)];

  const search = c.req.query("search");
  if (search !== undefined && search.trim().length > 0) {
    // Masked names are stored masked ("Ac** Lo*******") — a case-insensitive
    // prefix/substring match on the mask is the right trade-off: the raw PII
    // is never exposed to the query path.
    conditions.push(sql`LOWER(${cases.companyNameMask}) LIKE ${`%${search.toLowerCase()}%`}`);
  }
  const status = c.req.query("status");
  if (status !== undefined && status.length > 0) {
    conditions.push(eq(cases.status, status as CaseStatus));
  }
  const risk = c.req.query("risk");
  if (risk !== undefined && risk.length > 0) {
    conditions.push(eq(cases.riskScore, risk as RiskScore));
  }
  const where = and(...conditions);

  // Total count drives pagination + the X-Total-Count header.
  const countRows = await db.select({ count: sql<number>`count(*)::int` }).from(cases).where(where);
  const total = countRows[0]?.count ?? 0;

  const offset = Math.max(num(c.req.query("offset"), 0), 0);
  const limit = Math.min(Math.max(num(c.req.query("limit"), 20), 1), 100);
  const sort = c.req.query("sort");
  const orderDir = c.req.query("order") === "asc" ? asc : desc;
  const orderCol = sort === "risk" ? cases.riskScore : sort === "name" ? cases.companyNameMask : cases.createdAt;

  const rows = await db.select()
    .from(cases)
    .where(where)
    .orderBy(orderDir(orderCol))
    .offset(offset)
    .limit(limit);

  c.header("X-Total-Count", String(total));
  c.header("X-Page-Size", String(limit));
  return c.json({ cases: rows.map((row) => ({ id: row.id, companyName: row.companyNameMask, registrationNumber: row.registrationNumberMask, jurisdiction: row.jurisdiction, status: row.status, riskScore: row.riskScore, requiresHuman: row.requiresHuman, createdAt: row.createdAt })) });
});

caseRoutes.get("/cases/stream", async (c) => {
  const auth = getAuth(c);
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const rows = await db.select().from(cases).where(eq(cases.tenantId, auth.tenantId)).orderBy(desc(cases.updatedAt)).limit(20);
      controller.enqueue(encoder.encode(`event: snapshot\ndata: ${JSON.stringify(rows.map((row) => ({ id: row.id, status: row.status, riskScore: row.riskScore })))}\n\n`));
      controller.close();
    }
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
});


caseRoutes.get("/cases/export", async (c) => {
  const auth = getAuth(c);
  const rows = await db.select().from(cases).where(and(eq(cases.tenantId, auth.tenantId), isNull(cases.deletedAt))).orderBy(desc(cases.createdAt));
  return c.json({
    exportedAt: new Date().toISOString(),
    cases: rows.map((row) => ({
      id: row.id,
      companyName: decryptPii(row.companyNameEncrypted),
      registrationNumber: decryptPii(row.registrationNumberEncrypted),
      jurisdiction: row.jurisdiction,
      status: row.status,
      riskScore: row.riskScore,
      dossier: row.dossier
    }))
  });
});

caseRoutes.get("/cases/:id", async (c) => {
  const auth = getAuth(c);
  const caseId = c.req.param("id");
  const rows = await db.select().from(cases).where(and(eq(cases.id, caseId), eq(cases.tenantId, auth.tenantId))).limit(1);
  const row = rows[0];
  if (row === undefined) return problem(c, 404, "Not Found", "Case not found");
  const evidenceRows = await db.select().from(evidence).where(eq(evidence.caseId, caseId));
  const auditRows = await db.select().from(auditLogs).where(eq(auditLogs.caseId, caseId)).orderBy(desc(auditLogs.createdAt));
  return c.json({
    id: row.id,
    companyName: decryptPii(row.companyNameEncrypted),
    registrationNumber: decryptPii(row.registrationNumberEncrypted),
    jurisdiction: row.jurisdiction,
    status: row.status,
    riskScore: row.riskScore,
    requiresHuman: row.requiresHuman,
    dossier: row.dossier,
    graphState: row.graphState,
    evidence: evidenceRows.map((entry) => ({ key: entry.key, sourceUrl: decryptPii(entry.sourceUrlEncrypted), summary: entry.summary, hash: entry.contentHash })),
    audit: auditRows.map((entry) => ({ actor: entry.actor, action: entry.action, createdAt: entry.createdAt, hash: entry.hash }))
  });
});

caseRoutes.post("/cases/:id/approve", validateJson(approveSchema), async (c) => {
  const auth = getAuth(c);
  const caseId = c.req.param("id") ?? "";
  const body = getValidated<z.infer<typeof approveSchema>>(c);
  // INV-007: approval is the only exit from `pending_hitl`. Read first so we
  // 404 on a missing case and 409 on a case that is not awaiting review; the
  // conditional UPDATE (WHERE status = pending_hitl) makes concurrent
  // approves atomic — only one can win.
  const existing = await db.select().from(cases).where(and(eq(cases.id, caseId), eq(cases.tenantId, auth.tenantId))).limit(1);
  const row = existing[0];
  if (row === undefined) return problem(c, 404, "Not Found", "Case not found");
  if (row.status !== "pending_hitl") return problem(c, 409, "Conflict", "Only cases awaiting human review can be approved");
  const updateValues = body.riskOverride === undefined
    ? { status: "completed" as const, requiresHuman: false, completedAt: new Date(), updatedAt: new Date() }
    : { status: "completed" as const, requiresHuman: false, riskScore: body.riskOverride, completedAt: new Date(), updatedAt: new Date() };
  const result = await db.update(cases).set(updateValues).where(and(eq(cases.id, caseId), eq(cases.tenantId, auth.tenantId), eq(cases.status, "pending_hitl")));
  if (result.rowCount === 0) return problem(c, 409, "Conflict", "Case was already approved");
  await writeAuditLog({ tenantId: auth.tenantId, caseId, actor: auth.userId ?? "api", action: "case.approved", newValue: { notes: body.notes, riskOverride: body.riskOverride ?? null } });
  await enqueueWebhookEvent(auth.tenantId, "case.approved", { caseId });
  return c.json({ caseId, status: "completed" });
});

caseRoutes.post("/cases/:id/rescreen", requirePlanLimit("cases"), async (c) => {
  const auth = getAuth(c);
  if (auth.plan === "starter") return problem(c, 403, "Forbidden", "Rescreening requires Growth plan");
  const caseId = c.req.param("id") ?? "";
  await graphQueue.add("rescreen" as const, { caseId, tenantId: auth.tenantId });
  return c.json({ caseId, status: "queued" });
});

caseRoutes.get("/cases/:id/report", async (c) => {
  const auth = getAuth(c);
  const report = await generateReport(c.req.param("id") ?? "", auth.tenantId);
  if (c.req.query("format") === "pdf") {
    const pdf = await renderPdf(report);
    return new Response(new Uint8Array(pdf), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename=${report.caseId}.pdf` } });
  }
  return c.json(report);
});

/**
 * POST /cases/:id/report/verify — recomputes the report's content-integrity
 * signature and confirms it matches the stored one (Phase E / D6).
 */
caseRoutes.post("/cases/:id/report/verify", async (c) => {
  const auth = getAuth(c);
  const caseId = c.req.param("id") ?? "";
  const exists = await db.select({ id: cases.id }).from(cases).where(and(eq(cases.id, caseId), eq(cases.tenantId, auth.tenantId))).limit(1);
  if (exists.length === 0) return problem(c, 404, "Not Found", "Case not found");
  const report = await generateReport(caseId, auth.tenantId);
  const valid = verifyReportSignature(
    {
      reportId: report.reportId,
      caseId: report.caseId,
      tenantId: report.tenantId,
      generatedAt: report.generatedAt,
      dossier: report.dossier,
      evidenceChain: report.evidenceChain,
      auditTrail: report.auditTrail,
    },
    report.signature,
  );
  return c.json({
    valid,
    reportId: report.reportId,
    algorithm: report.signature.algorithm,
    signature: report.signature.signature,
    keyFingerprint: report.signature.keyFingerprint,
    canonicalFields: report.signature.canonicalFields,
  });
});

caseRoutes.delete("/cases/:id/erase", async (c) => {
  const auth = getAuth(c);
  const caseId = c.req.param("id");
  await db.delete(evidence).where(eq(evidence.caseId, caseId));
  await db.delete(cases).where(and(eq(cases.id, caseId), eq(cases.tenantId, auth.tenantId)));
  await writeAuditLog({ tenantId: auth.tenantId, caseId, actor: auth.userId ?? "api", action: "case.erased" });
  return c.json({ erased: true });
});
