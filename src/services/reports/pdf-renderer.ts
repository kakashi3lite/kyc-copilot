import { redis } from "../../db/index.js";
import { sha256Hex } from "../../utils/id.js";
import { childLogger } from "../../config/logger.js";
import { sharedBrowserPool, PoolTimeoutError } from "../browser/pool.js";
import type { ComplianceReportJson } from "../../types/index.js";

const PDF_CACHE_TTL_SECONDS = 300; // 5 minutes

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function reportHtml(report: ComplianceReportJson): string {
  const evidenceRows = report.evidenceChain.map((entry) => `<tr><td>${escapeHtml(entry.key)}</td><td>${escapeHtml(entry.kind)}</td><td>${escapeHtml(entry.summary)}</td><td>${escapeHtml(entry.hash)}</td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Inter,Arial,sans-serif;color:#172033;margin:36px}.brand{border-bottom:4px solid #2457ff;padding-bottom:12px}.badge{display:inline-block;padding:6px 10px;border-radius:999px;background:#eef2ff}table{border-collapse:collapse;width:100%;margin-top:16px}td,th{border:1px solid #d8deea;padding:8px;text-align:left}pre{white-space:pre-wrap}.sig{margin-top:36px;border:1px dashed #5b6475;padding:16px}</style></head><body><section class="brand"><h1>KYC-Copilot Compliance Report</h1><p>${escapeHtml(report.reportId)} · ${escapeHtml(report.generatedAt)}</p></section><h2>${escapeHtml(report.subject.companyName)}</h2><p class="badge">Risk: ${escapeHtml(report.riskScore)}</p><h3>AMLD6 citations</h3><ul>${report.articleCitations.map((article) => `<li>${escapeHtml(article.article)} — ${escapeHtml(article.title)}</li>`).join("")}</ul><h3>Dossier</h3><pre>${escapeHtml(report.dossier)}</pre><h3>Digital evidence chain</h3><table><thead><tr><th>Key</th><th>Kind</th><th>Summary</th><th>SHA-256</th></tr></thead><tbody>${evidenceRows}</tbody></table><div class="sig">PKCS#7 signature placeholder: ${escapeHtml(report.digitalSignatureBlock)}</div></body></html>`;
}

/**
 * Cache key derived from the *semantic* content of the report (excluding
 * the reportId, generatedAt, and auditTrail noise that varies per render).
 * Two requests for the same case+dossier+evidence produce the same key
 * and hit the same cache entry.
 */
function pdfCacheKey(report: ComplianceReportJson): string {
  const semanticContent = JSON.stringify({
    caseId: report.caseId,
    subject: report.subject,
    riskScore: report.riskScore,
    dossier: report.dossier,
    evidenceChain: report.evidenceChain,
    articleCitations: report.articleCitations
  });
  return `pdf:${report.caseId}:${sha256Hex(semanticContent)}`;
}

async function readCachedPdf(key: string): Promise<Buffer | null> {
  try {
    const cached = await redis.get(key);
    return cached === null ? null : Buffer.from(cached, "base64");
  } catch (error) {
    childLogger({ component: "pdf-renderer" }).warn({ error: error instanceof Error ? error.message : String(error) }, "pdf cache read failed");
    return null;
  }
}

async function writeCachedPdf(key: string, buffer: Buffer): Promise<void> {
  try {
    await redis.setex(key, PDF_CACHE_TTL_SECONDS, buffer.toString("base64"));
  } catch (error) {
    childLogger({ component: "pdf-renderer" }).warn({ error: error instanceof Error ? error.message : String(error) }, "pdf cache write failed");
  }
}

export async function renderPdf(report: ComplianceReportJson): Promise<Buffer> {
  const cacheKey = pdfCacheKey(report);

  const cached = await readCachedPdf(cacheKey);
  if (cached !== null) {
    childLogger({ component: "pdf-renderer" }).debug({ caseId: report.caseId }, "pdf cache hit");
    return cached;
  }

  const pool = sharedBrowserPool();
  const context = await pool.acquirePdfRenderPermit();
  try {
    const page = await context.newPage();
    await page.setContent(reportHtml(report), { waitUntil: "networkidle" });
    const pdfBuffer = Buffer.from(await page.pdf({ format: "A4", printBackground: true }));
    await writeCachedPdf(cacheKey, pdfBuffer);
    return pdfBuffer;
  } finally {
    pool.releasePdfRenderPermit(context);
  }
}

export { PoolTimeoutError };
