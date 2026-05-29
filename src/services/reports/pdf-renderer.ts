import puppeteer from "puppeteer";
import type { ComplianceReportJson } from "../../types/index.js";

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function reportHtml(report: ComplianceReportJson): string {
  const evidenceRows = report.evidenceChain.map((entry) => `<tr><td>${escapeHtml(entry.key)}</td><td>${escapeHtml(entry.kind)}</td><td>${escapeHtml(entry.summary)}</td><td>${escapeHtml(entry.hash)}</td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Inter,Arial,sans-serif;color:#172033;margin:36px}.brand{border-bottom:4px solid #2457ff;padding-bottom:12px}.badge{display:inline-block;padding:6px 10px;border-radius:999px;background:#eef2ff}table{border-collapse:collapse;width:100%;margin-top:16px}td,th{border:1px solid #d8deea;padding:8px;text-align:left}pre{white-space:pre-wrap}.sig{margin-top:36px;border:1px dashed #5b6475;padding:16px}</style></head><body><section class="brand"><h1>KYC-Copilot Compliance Report</h1><p>${escapeHtml(report.reportId)} · ${escapeHtml(report.generatedAt)}</p></section><h2>${escapeHtml(report.subject.companyName)}</h2><p class="badge">Risk: ${escapeHtml(report.riskScore)}</p><h3>AMLD6 citations</h3><ul>${report.articleCitations.map((article) => `<li>${escapeHtml(article.article)} — ${escapeHtml(article.title)}</li>`).join("")}</ul><h3>Dossier</h3><pre>${escapeHtml(report.dossier)}</pre><h3>Digital evidence chain</h3><table><thead><tr><th>Key</th><th>Kind</th><th>Summary</th><th>SHA-256</th></tr></thead><tbody>${evidenceRows}</tbody></table><div class="sig">PKCS#7 signature placeholder: ${escapeHtml(report.digitalSignatureBlock)}</div></body></html>`;
}

export async function renderPdf(report: ComplianceReportJson): Promise<Buffer> {
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setContent(reportHtml(report), { waitUntil: "networkidle0" });
    return Buffer.from(await page.pdf({ format: "A4", printBackground: true }));
  } finally {
    await browser.close();
  }
}
