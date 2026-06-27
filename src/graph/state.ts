import type { ApiCompanyData, BrowserResult, DossierClaim, EntityInput, EvidenceRecord, RiskScore } from "../types/index.js";

export interface AgentState extends EntityInput {
  caseId: string;
  tenantId: string;
  status: "queued" | "processing" | "pending_hitl" | "completed" | "failed";
  apiData: ApiCompanyData | null;
  browserResult: BrowserResult | null;
  evidenceLedger: Record<string, EvidenceRecord>;
  claims: DossierClaim[];
  dossier: string;
  riskScore: RiskScore;
  requiresHuman: boolean;
  uboVerified: boolean;
  browserFailed: boolean;
  guardrailFindings: string[];
  auditTrail: Array<{ actor: string; action: string; occurredAt: string; hash: string }>;
  llmSelection: Record<string, unknown> | null;
}

export type AgentStatePatch = Partial<AgentState>;

export function initialState(input: EntityInput & { caseId: string; tenantId: string }): AgentState {
  return {
    ...input,
    status: "queued",
    apiData: null,
    browserResult: null,
    evidenceLedger: {},
    claims: [],
    dossier: "",
    riskScore: "Pending",
    requiresHuman: false,
    uboVerified: false,
    browserFailed: false,
    guardrailFindings: [],
    auditTrail: [],
    llmSelection: null
  };
}

export function mergeState(state: AgentState, patch: AgentStatePatch): AgentState {
  return {
    ...state,
    ...patch,
    evidenceLedger: { ...state.evidenceLedger, ...patch.evidenceLedger },
    claims: patch.claims ?? state.claims,
    guardrailFindings: patch.guardrailFindings ?? state.guardrailFindings,
    auditTrail: patch.auditTrail ?? state.auditTrail,
    llmSelection: patch.llmSelection ?? state.llmSelection
  };
}
