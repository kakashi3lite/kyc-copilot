import type { AgentState } from "./state.js";

export type NextNode = "browserFallback" | "draftDossier" | "humanReview" | "end";

export function afterApiLookup(state: AgentState): NextNode {
  // Skip the browser fallback when the API data is complete and nothing has
  // flagged human review — the deterministic adapter returns completeness
  // "complete" with no sanctions, so low-risk zero-key cases take the fast
  // path straight to dossier drafting.
  return state.apiData?.completeness === "complete" && !state.requiresHuman ? "draftDossier" : "browserFallback";
}

export function afterGuardrail(state: AgentState): NextNode {
  return state.requiresHuman ? "humanReview" : "end";
}
