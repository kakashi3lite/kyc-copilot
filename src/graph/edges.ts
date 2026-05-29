import type { AgentState } from "./state.js";

export type NextNode = "browserFallback" | "draftDossier" | "humanReview" | "end";

export function afterApiLookup(state: AgentState): NextNode {
  return state.apiData?.completeness === "complete" && state.uboVerified ? "draftDossier" : "browserFallback";
}

export function afterGuardrail(state: AgentState): NextNode {
  return state.requiresHuman ? "humanReview" : "end";
}
