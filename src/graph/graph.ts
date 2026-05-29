import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { AgentState, AgentStatePatch } from "./state.js";
import { initialState, mergeState } from "./state.js";
import { afterApiLookup } from "./edges.js";
import { ingestNode } from "./nodes/ingest.js";
import { apiLookupNode, type ApiLookupDependencies } from "./nodes/api-lookup.js";
import { browserFallbackNode, type BrowserFallbackDependencies } from "./nodes/browser-fallback.js";
import { draftDossierNode, type DraftDossierDependencies } from "./nodes/draft-dossier.js";
import { guardrailNode } from "./nodes/guardrail.js";
import type { EntityInput } from "../types/index.js";
import { withTimeout } from "../utils/retry.js";
import { env } from "../config/env.js";

export type GraphDependencies = ApiLookupDependencies & BrowserFallbackDependencies & DraftDossierDependencies;

export class KycGraph {
  public constructor(private readonly deps: GraphDependencies) {}

  public async run(input: EntityInput & { caseId: string; tenantId: string }): Promise<AgentState> {
    let state = initialState(input);
    state = mergeState(state, await withTimeout(ingestNode(state), 5000, "ingest"));
    state = mergeState(state, await withTimeout(apiLookupNode(state, this.deps), 30000, "api-lookup"));
    if (afterApiLookup(state) === "browserFallback") {
      state = mergeState(state, await withTimeout(browserFallbackNode(state, this.deps), 60000, "browser"));
    }
    state = mergeState(state, await withTimeout(draftDossierNode(state, this.deps), 30000, "draft"));
    state = mergeState(state, await withTimeout(guardrailNode(state), 30000, "guardrail"));
    return state;
  }

  public applyPatch(state: AgentState, patch: AgentStatePatch): AgentState {
    return mergeState(state, patch);
  }
}

export function createPostgresCheckpointer(): PostgresSaver {
  return PostgresSaver.fromConnString(env.DATABASE_URL);
}
