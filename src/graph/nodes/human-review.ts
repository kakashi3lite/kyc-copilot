import type { AgentState, AgentStatePatch } from "../state.js";
import type { RiskScore } from "../../types/index.js";
import { nowIso } from "../../utils/date.js";
import { sha256Hex } from "../../utils/id.js";

export async function humanReviewNode(state: AgentState, reviewer: string, riskOverride?: RiskScore): Promise<AgentStatePatch> {
  const riskScore = riskOverride ?? state.riskScore;
  return {
    riskScore,
    requiresHuman: false,
    status: "completed",
    auditTrail: [...state.auditTrail, { actor: reviewer, action: "case.approved", occurredAt: nowIso(), hash: sha256Hex(`${state.caseId}:${reviewer}:${riskScore}`) }]
  };
}
