import type { KycDataAdapter } from "../../services/kyc-data/adapter.js";
import type { AgentState, AgentStatePatch } from "../state.js";
import { ApiCompanyDataSchema } from "../schemas.js";
import { sha256Hex } from "../../utils/id.js";
import { nowIso } from "../../utils/date.js";

export interface ApiLookupDependencies { adapter: KycDataAdapter; }

export async function apiLookupNode(state: AgentState, deps: ApiLookupDependencies): Promise<AgentStatePatch> {
  const data = ApiCompanyDataSchema.parse(await deps.adapter.lookup(state));
  const key = "API_1";
  const evidence = {
    key,
    sourceUrl: data.sourceUrl,
    summary: `Structured registry and screening data for ${state.jurisdiction}`,
    kind: "api" as const,
    capturedAt: nowIso(),
    version: 1,
    hash: sha256Hex(JSON.stringify(data))
  };
  return {
    apiData: data,
    uboVerified: data.ubos.length > 0 && data.ubos.every((ubo) => ubo.verified),
    evidenceLedger: { [key]: evidence },
    requiresHuman: data.sanctions.some((hit) => hit.matched) || data.completeness === "partial"
  };
}
