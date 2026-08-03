import type { KycDataAdapter } from "../../services/kyc-data/adapter.js";
import type { AgentState, AgentStatePatch } from "../state.js";
import { ApiCompanyDataSchema } from "../schemas.js";
import { sha256Hex } from "../../utils/id.js";
import { nowIso } from "../../utils/date.js";

export interface ApiLookupDependencies { adapter: KycDataAdapter; }

export async function apiLookupNode(state: AgentState, deps: ApiLookupDependencies): Promise<AgentStatePatch> {
  const data = ApiCompanyDataSchema.parse(await deps.adapter.lookup(state));
  const key = "API_1";
  // D5: surface the UBO count in the evidence summary when the registry
  // reported beneficial owners; keep the base summary unchanged otherwise.
  const uboNote = data.ubos.length > 0 ? ` · ${data.ubos.length} beneficial owner(s) reported by registry` : "";
  const evidence = {
    key,
    sourceUrl: data.sourceUrl,
    summary: `Structured registry and screening data for ${state.jurisdiction}${uboNote}`,
    kind: "api" as const,
    capturedAt: nowIso(),
    version: 1,
    hash: sha256Hex(JSON.stringify(data))
  };
  return {
    apiData: data,
    uboVerified: data.ubos.length > 0 && data.ubos.every((ubo) => ubo.verified),
    evidenceLedger: { [key]: evidence },
    // Requires human review if the screening flagged a sanctions match or a
    // PEP, or if the registry data is partial (incomplete UBO/address info).
    requiresHuman: data.sanctions.some((hit) => hit.matched) || data.pep || data.completeness === "partial"
  };
}
