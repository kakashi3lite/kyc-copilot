import { EntityInputSchema } from "../schemas.js";
import type { AgentState, AgentStatePatch } from "../state.js";
import { sanitizeInput } from "../../utils/mask.js";
import { sha256Hex } from "../../utils/id.js";
import { nowIso } from "../../utils/date.js";

export async function ingestNode(state: AgentState): Promise<AgentStatePatch> {
  const parsed = EntityInputSchema.parse({
    companyName: sanitizeInput(state.companyName),
    registrationNumber: sanitizeInput(state.registrationNumber),
    jurisdiction: sanitizeInput(state.jurisdiction).toUpperCase()
  });
  return {
    ...parsed,
    status: "processing",
    auditTrail: [{ actor: "system", action: "case.ingested", occurredAt: nowIso(), hash: sha256Hex(`${state.caseId}:ingested`) }]
  };
}
