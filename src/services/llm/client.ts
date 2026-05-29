import type { AgentState } from "../../graph/state.js";
import type { RiskScore } from "../../types/index.js";
import { sanitizeInput } from "../../utils/mask.js";

export interface DossierDraft { claims: Array<{ id: string; text: string; sourceKey: string }>; riskScore: RiskScore; summary: string; }
export interface LlmClient { draftDossier(state: AgentState): Promise<DossierDraft>; }

const blackList = new Set(["KP", "IR", "MM"]);
const greyList = new Set(["BG", "HR", "CD", "HT", "ML", "MZ", "NA", "NG", "PH", "SN", "SS", "SY", "TZ", "VE", "VN", "YE"]);

export class DeterministicLlmClient implements LlmClient {
  public async draftDossier(state: AgentState): Promise<DossierDraft> {
    const company = sanitizeInput(state.companyName);
    const apiKey = Object.keys(state.evidenceLedger)[0] ?? "API_1";
    const sanctionHit = state.apiData?.sanctions.some((hit) => hit.matched) === true;
    const riskScore: RiskScore = sanctionHit || blackList.has(state.jurisdiction) ? "High" : greyList.has(state.jurisdiction) || !state.uboVerified ? "Medium" : "Low";
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
