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
  const sanctionsRisk = state.apiData?.sanctions.some((hit) => hit.matched) === true;
  const pepRisk = state.apiData?.pep === true;
  const highRisk = state.riskScore === "High" || sanctionsRisk;
  const mediumUnverified = state.riskScore === "Medium" && !state.uboVerified;
  const partialData = state.apiData?.completeness === "partial";
  // Decision table (ADR-013): HITL only on sanctions/PEP, High risk, Medium
  // with unverified UBO, partial data, or a browser failure. Low + complete
  // completes even when UBOs were not individually verified (the registry
  // returned no UBO data — a documented limitation, not a fraud signal).
  const hitl = sanctionsRisk || pepRisk || highRisk || mediumUnverified || partialData || state.browserFailed;
  return {
    dossier: sanitizedLines.join("\n"),
    guardrailFindings: findings,
    requiresHuman: hitl,
    status: hitl ? "pending_hitl" : "completed"
  };
}
