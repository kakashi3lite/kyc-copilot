import type { AgentState } from "../../graph/state.js";
import type { RiskScore } from "../../types/index.js";
import type { GraphContext } from "../kyc-data/graph-query.js";
import { sanitizeInput } from "../../utils/mask.js";

export interface DossierDraft { claims: Array<{ id: string; text: string; sourceKey: string }>; riskScore: RiskScore; summary: string; }

/**
 * LLM client contract. `graphCtx` is optional cross-case knowledge-graph
 * context (Sprint 5); when provided it is woven into the dossier prompt so
 * the model can cite prior assessments and related entities. Implementations
 * that do not use graph context (e.g. the deterministic T0 client) simply
 * ignore it — the parameter is optional for that reason.
 */
export interface LlmClient { draftDossier(state: AgentState, graphCtx?: GraphContext | null): Promise<DossierDraft>; }

const blackList = new Set(["KP", "IR", "MM"]);
const greyList = new Set(["BG", "HR", "CD", "HT", "ML", "MZ", "NA", "NG", "PH", "SN", "SS", "SY", "TZ", "VE", "VN", "YE"]);

export class DeterministicLlmClient implements LlmClient {
  public async draftDossier(state: AgentState): Promise<DossierDraft> {
    const company = sanitizeInput(state.companyName);
    const apiKey = Object.keys(state.evidenceLedger)[0] ?? "API_1";
    const sanctionHit = state.apiData?.sanctions.some((hit) => hit.matched) === true;
    // Complete registry data without individual UBO rows is a documented
    // limitation of the deterministic adapter, not a fraud signal — so a
    // complete, non-elevated-jurisdiction entity scores Low even when UBO
    // verification is absent (aligns with guardrail decision table, ADR-013).
    const completeData = state.apiData?.completeness === "complete";
    const riskScore: RiskScore = sanctionHit || blackList.has(state.jurisdiction) ? "High" : greyList.has(state.jurisdiction) ? "Medium" : completeData ? "Low" : !state.uboVerified ? "Medium" : "Low";
    return {
      riskScore,
      summary: `${company} was assessed under AMLD6 enhanced due diligence controls. [Source: ${apiKey}]`,
      claims: [
        { id: "claim-status", text: `Registry status is ${state.apiData?.status ?? "unknown"}.`, sourceKey: apiKey },
        { id: "claim-ubo", text: state.uboVerified ? "Ultimate beneficial ownership was verified." : "Ultimate beneficial ownership requires analyst verification.", sourceKey: apiKey },
        { id: "claim-screening", text: sanctionHit ? "Screening returned a sanctions-related match." : "Screening returned no sanctions match.", sourceKey: apiKey }
      ]
    };
  }
}
