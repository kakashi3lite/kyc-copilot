export type CaseStatus = "queued" | "processing" | "pending_hitl" | "completed" | "failed" | "archived";
export type RiskScore = "Low" | "Medium" | "High" | "Pending";
export type Plan = "starter" | "growth" | "enterprise";
export type EvidenceKind = "api" | "browser" | "document" | "system";
export type WebhookEvent = "case.created" | "case.completed" | "case.pending_hitl" | "case.failed" | "case.approved" | "webhook.test";

export interface EntityInput {
  companyName: string;
  registrationNumber: string;
  jurisdiction: string;
}

export interface EvidenceRecord {
  key: string;
  sourceUrl: string;
  summary: string;
  kind: EvidenceKind;
  capturedAt: string;
  version: number;
  hash: string;
}

export interface DossierClaim {
  id: string;
  text: string;
  sourceKey: string;
}

export interface ApiCompanyData {
  legalName: string;
  registrationNumber: string;
  jurisdiction: string;
  status: "active" | "inactive" | "unknown";
  incorporationDate: string | null;
  address: string | null;
  ubos: ReadonlyArray<{ name: string; verified: boolean; ownershipPct: number }>;
  sanctions: ReadonlyArray<{ list: string; matched: boolean; name: string }>;
  pep: boolean;
  sourceUrl: string;
  completeness: "complete" | "partial";
}

export interface BrowserResult {
  data: ApiCompanyData | null;
  evidence: EvidenceRecord | null;
  requiresHuman: boolean;
  reason: string;
}

export interface ComplianceReportJson {
  reportId: string;
  caseId: string;
  tenantId: string;
  generatedAt: string;
  framework: "AMLD6";
  articleCitations: ReadonlyArray<{ article: string; title: string; effectiveFrom: string }>;
  subject: EntityInput;
  riskScore: RiskScore;
  dossier: string;
  evidenceChain: ReadonlyArray<EvidenceRecord>;
  auditTrail: ReadonlyArray<{ actor: string; action: string; occurredAt: string; hash: string }>;
  digitalSignatureBlock: string;
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
}
