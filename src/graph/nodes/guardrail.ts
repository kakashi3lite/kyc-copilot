import type { AgentState, AgentStatePatch } from "../state.js";

const citationPattern = /\[Source:\s*([A-Z0-9_:-]+)\]/g;

export async function guardrailNode(state: AgentState): Promise<AgentStatePatch> {
  const validKeys = new Set(Object.keys(state.evidenceLedger));
  const findings: string[] = [];
  const sanitizedLines = state.dossier.split("\n").filter((line) => {
    const citations = [...line.matchAll(citationPattern)].map((match) => match[1]).filter((key): key is string => key !== undefined);
    if (citations.length === 0 && /\w/.test(line)) {
      findings.push(`Removed uncited claim: ${line.slice(0, 80)}`);
      return false;
    }
    const invalid = citations.some((key) => !validKeys.has(key));
    if (invalid) {
      findings.push(`Removed claim with invalid evidence key: ${line.slice(0, 80)}`);
      return false;
    }
    return true;
  });
  const highRisk = state.riskScore === "High" || state.apiData?.sanctions.some((hit) => hit.matched) === true;
  return {
    dossier: sanitizedLines.join("\n"),
    guardrailFindings: findings,
    requiresHuman: state.requiresHuman || highRisk || !state.uboVerified || state.browserFailed,
    status: state.requiresHuman || highRisk || !state.uboVerified || state.browserFailed ? "pending_hitl" : "completed"
  };
}
