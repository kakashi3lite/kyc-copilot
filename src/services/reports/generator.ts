import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { amld6Articles, auditLogs, cases, evidence } from "../../db/schema.js";
import { decryptPii } from "../encryption/at-rest.js";
import { newId, sha256Hex } from "../../utils/id.js";
import { nowIso } from "../../utils/date.js";
import type { ComplianceReportJson, EvidenceRecord } from "../../types/index.js";

export async function generateReport(caseId: string, tenantId: string): Promise<ComplianceReportJson> {
  const rows = await db.select().from(cases).where(and(eq(cases.id, caseId), eq(cases.tenantId, tenantId))).limit(1);
  const row = rows[0];
  if (row === undefined) throw new Error("Case not found");
  const evidenceRows = await db.select().from(evidence).where(eq(evidence.caseId, caseId));
  const audits = await db.select().from(auditLogs).where(eq(auditLogs.caseId, caseId));
  const articles = await db.select().from(amld6Articles);
  const evidenceChain: EvidenceRecord[] = evidenceRows.map((entry) => ({
    key: entry.key,
    sourceUrl: decryptPii(entry.sourceUrlEncrypted),
    summary: entry.summary,
    kind: entry.kind === "api" || entry.kind === "browser" || entry.kind === "document" || entry.kind === "system" ? entry.kind : "system",
    capturedAt: entry.createdAt.toISOString(),
    version: entry.version,
    hash: entry.contentHash
  }));
  return {
    reportId: newId("rpt"),
    caseId,
    tenantId,
    generatedAt: nowIso(),
    framework: "AMLD6",
    articleCitations: articles.map((article) => ({ article: article.article, title: article.title, effectiveFrom: article.effectiveFrom.toISOString() })),
    subject: { companyName: decryptPii(row.companyNameEncrypted), registrationNumber: decryptPii(row.registrationNumberEncrypted), jurisdiction: row.jurisdiction },
    riskScore: row.riskScore,
    dossier: row.dossier,
    evidenceChain,
    auditTrail: audits.map((audit) => ({ actor: audit.actor, action: audit.action, occurredAt: audit.createdAt.toISOString(), hash: audit.hash })),
    digitalSignatureBlock: sha256Hex(`${caseId}:${row.updatedAt.toISOString()}:${evidenceChain.map((entry) => entry.hash).join("|")}`)
  };
}
