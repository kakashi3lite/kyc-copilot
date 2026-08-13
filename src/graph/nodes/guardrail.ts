import type { AgentState, AgentStatePatch } from "../state.js";
import { KYT_ESCALATION_MIN_CONFIDENCE } from "../../services/kyt/typology.js";

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
  // KYT (Phase 3): a high-confidence non-clean typology on wallet data
  // escalates to HITL. Absent transactionData, `kytVerdict` is null and this
  // adds nothing — zero-key and current pipelines are byte-for-byte unchanged.
  const kyt = state.kytVerdict ?? null;
  const kytRisk = kyt !== null && kyt.typology !== "clean" && kyt.confidence >= KYT_ESCALATION_MIN_CONFIDENCE;
  if (kytRisk) {
    findings.push(`KYT typology ${kyt.typology} (confidence ${kyt.confidence.toFixed(2)}) requires human review`);
  }
  // Decision table (ADR-013): HITL only on sanctions/PEP, High risk, Medium
  // with unverified UBO, partial data, a browser failure, or a KYT risk flag.
  // Low + complete completes even when UBOs were not individually verified
  // (the registry returned no UBO data — a documented limitation, not a
  // fraud signal).
  const hitl = sanctionsRisk || pepRisk || highRisk || mediumUnverified || partialData || state.browserFailed || kytRisk;
  return {
    dossier: sanitizedLines.join("\n"),
    guardrailFindings: findings,
    requiresHuman: hitl,
    status: hitl ? "pending_hitl" : "completed"
  };
}
