import type { LlmClient } from "../../services/llm/client.js";
import type { AgentState, AgentStatePatch } from "../state.js";
import { DossierSchema } from "../schemas.js";

export interface DraftDossierDependencies { llm: LlmClient; }

export async function draftDossierNode(state: AgentState, deps: DraftDossierDependencies): Promise<AgentStatePatch> {
  const result = DossierSchema.parse(await deps.llm.draftDossier(state));
  const dossier = [
    `Enhanced Due Diligence dossier for ${state.companyName}. [Source: API_1]`,
    result.summary,
    ...result.claims.map((claim) => `- ${claim.text} [Source: ${claim.sourceKey}]`)
  ].join("\n");
  return { claims: result.claims, dossier, riskScore: result.riskScore };
}
