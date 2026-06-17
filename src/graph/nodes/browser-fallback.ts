import type { BrowserFallbackService } from "../../services/browser/pool.js";
import { PoolTimeoutError } from "../../services/browser/pool.js";
import type { AgentState, AgentStatePatch } from "../state.js";

export interface BrowserFallbackDependencies { browser: BrowserFallbackService; }

export async function browserFallbackNode(state: AgentState, deps: BrowserFallbackDependencies): Promise<AgentStatePatch> {
  if (state.apiData?.completeness === "complete" && state.uboVerified) return {};
  let result;
  try {
    result = await deps.browser.lookup(state);
  } catch (error) {
    if (error instanceof PoolTimeoutError) {
      // Pool saturated — the graph cannot proceed without a browser result.
      // INV-007 requires HITL escalation rather than auto-completion, so we
      // set requiresHuman: true and let the analyst re-run the case later
      // when the pool has capacity.
      return {
        browserFailed: true,
        requiresHuman: true,
        guardrailFindings: [`browser pool timeout: ${error.message}`]
      };
    }
    throw error;
  }
  return {
    browserResult: result,
    browserFailed: result.requiresHuman,
    requiresHuman: state.requiresHuman || result.requiresHuman,
    apiData: result.data ?? state.apiData,
    evidenceLedger: result.evidence ? { [result.evidence.key]: result.evidence } : {}
  };
}
