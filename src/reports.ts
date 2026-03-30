/**
 * reports.ts — AMLD6-aligned Compliance Report Generator
 *
 * This is the product's core deliverable for the customer.
 * Every EU PSP must demonstrate to their NCA (National Competent Authority)
 * that they performed adequate CDD/EDD — this report is that proof.
 *
 * Report design principles:
 *   1. Machine-readable (JSON) + Human-readable (Markdown) in one structure
 *   2. Immutable reference ID (REPORT-{8 chars}) for audit trail
 *   3. Links every dossier claim to its evidence source
 *   4. Cites the specific AMLD6 article that governs the risk level
 *   5. Includes chain-of-custody: who created, when, who approved
 *
 * Production upgrade path:
 *   Pass the JSON to Puppeteer or a PDF library to render a branded
 *   PDF with the institution's letterhead — this is the €100-€500/report
 *   upsell for enterprise customers.
 */

import type { CaseRecord } from "./cases.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** AMLD6 article mapping by risk score — used in the report header */
const AMLD6_ARTICLES: Record<string, { article: string; description: string }> = {
  Low:     { article: "Art. 13",      description: "Customer Due Diligence (CDD)" },
  Medium:  { article: "Art. 13–14",   description: "Enhanced Customer Due Diligence — Intermediate Risk" },
  High:    { article: "Art. 18",      description: "Enhanced Due Diligence (EDD) — High-Risk Third Countries / PEP" },
  Pending: { article: "Art. 13",      description: "Assessment Pending" },
};

export interface EvidenceEntry {
  claimId:      string;
  source:       string;
  capturedAt:   string;  // ISO timestamp
  sourceType:   "api" | "browser_screenshot" | "document";
}

export interface ComplianceReport {
  /** Stable reference ID for the regulator's file */
  reportId:          string;
  generatedAt:       string;
  schemaVersion:     "1.0";

  /** Regulatory context */
  regulatory: {
    framework:   string;
    article:     string;
    description: string;
    jurisdiction: string;
  };

  /** Entity under review */
  subject: {
    caseId:             string;
    companyName:        string;
    registrationNumber: string;
    jurisdiction:       string;
  };

  /** Risk outcome */
  riskClassification: {
    score:                    string;
    requiresEnhancedMonitoring: boolean;
    requiresOngoingScreening:   boolean;
    assessedAt:               string;
  };

  /** The verified EDD dossier text */
  dossier: string;

  /**
   * Evidence chain — every entry maps a claim ID to its source.
   * This is what the NCA auditor reviews to verify the evidence trail.
   */
  evidenceChain: EvidenceEntry[];

  /** Chain of custody */
  auditTrail: {
    caseCreatedAt:         string;
    humanReviewRequired:   boolean;
    humanReviewCompletedAt: string | null;
    reviewerNotes:         string | null;
    reportGeneratedBy:     string;  // API key label / user
  };

  /** Machine-readable summary for downstream systems */
  summary: {
    passedCDD:        boolean;
    passedSanctions:  boolean;
    passedPEP:        boolean;
    uboIdentified:    boolean;
    ongoingMonitoringRequired: boolean;
  };
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

/**
 * Generates a compliance report from a completed case record.
 *
 * @param cas             The case record from cases.ts
 * @param generatedBy     Label of the API key / user generating the report
 */
export function generateReport(cas: CaseRecord, generatedBy = "API"): ComplianceReport {
  const now   = new Date().toISOString();
  const artId = AMLD6_ARTICLES[cas.riskScore] ?? AMLD6_ARTICLES["Pending"] ?? { article: "Art. 13", description: "Customer Due Diligence" };

  // Derive a stable report ID from the case ID
  const reportId = `RPT-${cas.caseId.slice(0, 8).toUpperCase()}`;

  // Map the evidence ledger into the structured evidence chain
  const evidenceChain: EvidenceEntry[] = Object.entries(cas.evidenceLedger).map(
    ([claimId, source]) => ({
      claimId,
      source,
      capturedAt: now,
      sourceType: claimId.startsWith("BROWSER") ? "browser_screenshot" : "api",
    })
  );

  // Derive risk-level flags from available data
  const riskHigh  = cas.riskScore === "High";
  const riskMed   = cas.riskScore === "Medium";

  return {
    reportId,
    generatedAt:   now,
    schemaVersion: "1.0",

    regulatory: {
      framework:   "EU Anti-Money Laundering Directive 6 (AMLD6 / Directive 2018/843)",
      article:     artId.article,
      description: artId.description,
      jurisdiction: cas.jurisdiction,
    },

    subject: {
      caseId:             cas.caseId,
      companyName:        cas.companyName,
      registrationNumber: cas.registrationNumber,
      jurisdiction:       cas.jurisdiction,
    },

    riskClassification: {
      score:                      cas.riskScore,
      requiresEnhancedMonitoring: riskHigh || riskMed,
      requiresOngoingScreening:   riskHigh,
      assessedAt:                 cas.updatedAt.toISOString(),
    },

    dossier: cas.draftDossier,

    evidenceChain,

    auditTrail: {
      caseCreatedAt:         cas.createdAt.toISOString(),
      humanReviewRequired:   cas.requiresHuman,
      humanReviewCompletedAt: cas.completedAt?.toISOString() ?? null,
      reviewerNotes:         cas.reviewerNotes,
      reportGeneratedBy:     generatedBy,
    },

    summary: {
      passedCDD:                 cas.status === "completed",
      passedSanctions:           !cas.draftDossier.toLowerCase().includes("sanctions hit"),
      passedPEP:                 !cas.draftDossier.toLowerCase().includes("pep match"),
      uboIdentified:             cas.draftDossier.toLowerCase().includes("ubo") &&
                                 !cas.draftDossier.toLowerCase().includes("unverified"),
      ongoingMonitoringRequired: riskHigh || riskMed,
    },
  };
}

/**
 * Renders the compliance report as a Markdown string.
 * Useful for quick human review before generating a PDF.
 */
export function renderReportAsMarkdown(r: ComplianceReport): string {
  const ledgerRows = r.evidenceChain
    .map((e) => `| ${e.claimId} | ${e.sourceType} | ${e.source} |`)
    .join("\n");

  return `# Compliance Report — ${r.reportId}

**Generated:** ${r.generatedAt}  
**Schema:** v${r.schemaVersion}

---

## Regulatory Basis

| Field | Value |
|-------|-------|
| Framework | ${r.regulatory.framework} |
| Article | ${r.regulatory.article} |
| Description | ${r.regulatory.description} |

---

## Subject

| Field | Value |
|-------|-------|
| Case ID | ${r.subject.caseId} |
| Company | ${r.subject.companyName} |
| Registration | ${r.subject.registrationNumber} |
| Jurisdiction | ${r.subject.jurisdiction} |

---

## Risk Classification

**Score: ${r.riskClassification.score}**  
Enhanced monitoring: ${r.riskClassification.requiresEnhancedMonitoring ? "Yes" : "No"}  
Ongoing screening:   ${r.riskClassification.requiresOngoingScreening ? "Yes" : "No"}

---

## EDD Dossier

${r.dossier}

---

## Evidence Chain

| Claim ID | Type | Source |
|----------|------|--------|
${ledgerRows}

---

## Audit Trail

| Field | Value |
|-------|-------|
| Case Created | ${r.auditTrail.caseCreatedAt} |
| Human Review Required | ${r.auditTrail.humanReviewRequired} |
| Human Review Completed | ${r.auditTrail.humanReviewCompletedAt ?? "N/A"} |
| Reviewer Notes | ${r.auditTrail.reviewerNotes ?? "None"} |
| Generated By | ${r.auditTrail.reportGeneratedBy} |

---

*This report was generated by KYC Copilot. It does not constitute legal advice.*
`;
}
