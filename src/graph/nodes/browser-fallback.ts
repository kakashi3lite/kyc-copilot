import type { BrowserFallbackService } from "../../services/browser/pool.js";
import type { AgentState, AgentStatePatch } from "../state.js";

export interface BrowserFallbackDependencies { browser: BrowserFallbackService; }

export async function browserFallbackNode(state: AgentState, deps: BrowserFallbackDependencies): Promise<AgentStatePatch> {
  if (state.apiData?.completeness === "complete" && state.uboVerified) return {};
  const result = await deps.browser.lookup(state);
  return {
    browserResult: result,
    browserFailed: result.requiresHuman,
    requiresHuman: state.requiresHuman || result.requiresHuman,
    apiData: result.data ?? state.apiData,
    evidenceLedger: result.evidence ? { [result.evidence.key]: result.evidence } : {}
  };
}
