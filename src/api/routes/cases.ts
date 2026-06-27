import { Hono } from "hono";
import { env } from "../../config/env.js";
import { z } from "zod";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../../db/index.js";
import { auditLogs, cases, evidence } from "../../db/schema.js";
import { graphQueue, runCase } from "../../workers/graph-runner.js";
import { encryptPii, decryptPii } from "../../services/encryption/at-rest.js";
import { generateReport } from "../../services/reports/generator.js";
import { renderPdf } from "../../services/reports/pdf-renderer.js";
import { writeAuditLog } from "../../services/audit/logger.js";
import { enqueueWebhookEvent } from "../../services/webhooks/dispatcher.js";
import { maskName, maskRegistration } from "../../utils/mask.js";
import { newId } from "../../utils/id.js";
import { validateJson, getValidated } from "../middleware/validate.js";
import { getAuth } from "../middleware/auth.js";
import { problem } from "../middleware/error-handler.js";

const createCaseSchema = z.object({ companyName: z.string().min(1), registrationNumber: z.string().min(1), jurisdiction: z.string().length(2) });
const approveSchema = z.object({ notes: z.string().default(""), riskOverride: z.enum(["Low", "Medium", "High", "Pending"]).optional() });

export const caseRoutes = new Hono();

caseRoutes.post("/cases", validateJson(createCaseSchema), async (c) => {
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
  } else {
    await graphQueue.add("run", { caseId, tenantId: auth.tenantId });
  }
  return c.json({ caseId, status: "queued" }, 201);
});

caseRoutes.get("/cases", async (c) => {
  const auth = getAuth(c);
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 100);
  const rows = await db.select().from(cases).where(and(eq(cases.tenantId, auth.tenantId), isNull(cases.deletedAt))).orderBy(desc(cases.createdAt)).limit(limit);
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
  const caseId = c.req.param("id");
  const body = getValidated<z.infer<typeof approveSchema>>(c);
  const updateValues = body.riskOverride === undefined
    ? { status: "completed" as const, requiresHuman: false, completedAt: new Date(), updatedAt: new Date() }
    : { status: "completed" as const, requiresHuman: false, riskScore: body.riskOverride, completedAt: new Date(), updatedAt: new Date() };
  await db.update(cases).set(updateValues).where(and(eq(cases.id, caseId), eq(cases.tenantId, auth.tenantId)));
  await writeAuditLog({ tenantId: auth.tenantId, caseId, actor: auth.userId ?? "api", action: "case.approved", newValue: { notes: body.notes, riskOverride: body.riskOverride ?? null } });
  await enqueueWebhookEvent(auth.tenantId, "case.approved", { caseId });
  return c.json({ caseId, status: "completed" });
});

caseRoutes.post("/cases/:id/rescreen", async (c) => {
  const auth = getAuth(c);
  if (auth.plan === "starter") return problem(c, 403, "Forbidden", "Rescreening requires Growth plan");
  const caseId = c.req.param("id");
  await graphQueue.add("rescreen", { caseId, tenantId: auth.tenantId });
  return c.json({ caseId, status: "queued" });
});

caseRoutes.get("/cases/:id/report", async (c) => {
  const auth = getAuth(c);
  const report = await generateReport(c.req.param("id"), auth.tenantId);
  if (c.req.query("format") === "pdf") {
    const pdf = await renderPdf(report);
    return new Response(new Uint8Array(pdf), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename=${report.caseId}.pdf` } });
  }
  return c.json(report);
});

caseRoutes.delete("/cases/:id/erase", async (c) => {
  const auth = getAuth(c);
  const caseId = c.req.param("id");
  await db.delete(evidence).where(eq(evidence.caseId, caseId));
  await db.delete(cases).where(and(eq(cases.id, caseId), eq(cases.tenantId, auth.tenantId)));
  await writeAuditLog({ tenantId: auth.tenantId, caseId, actor: auth.userId ?? "api", action: "case.erased" });
  return c.json({ erased: true });
});
