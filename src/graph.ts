/**
 * graph.ts
 *
 * Assembles and compiles the AML/KYC LangGraph state machine.
 *
 * Responsibilities:
 *  - Create the `StateGraph` using `AgentStateAnnotation`.
 *  - Register all six nodes.
 *  - Wire fixed edges (always-run transitions).
 *  - Wire conditional edges (routing decisions based on state values).
 *  - Attach a `MemorySaver` checkpointer for persistent state across interrupts.
 *  - Compile with `interruptBefore: ["humanReviewNode"]` for HITL support.
 *
 * IMPORTANT — TypeScript builder pattern:
 *   LangGraph.js uses a typed builder where each `.addNode()` call returns a
 *   NEW type that knows about the freshly registered node. This means ALL
 *   node registrations and edge definitions must be chained in a single
 *   expression — you cannot split them across separate statements.
 *
 * The compiled graph (`compiledGraph`) is exported for use by the HTTP server
 * in `index.ts`. The server invokes it, pauses at the HITL interrupt, and
 * resumes it after human approval.
 */

import { StateGraph, END, START, MemorySaver } from "@langchain/langgraph";
import { AgentStateAnnotation } from "./state.js";
import type { AgentState } from "./state.js";
import {
  ingestDataNode,
  apiLookupNode,
  browserFallbackNode,
  draftDossierNode,
  guardrailNode,
  humanReviewNode,
} from "./nodes.js";

// ---------------------------------------------------------------------------
// Conditional edge functions
// ---------------------------------------------------------------------------

/**
 * Routes after `apiLookupNode` based on the LLM's routing decision.
 *
 * The routing LLM in `apiLookupNode` sets `apiData.__routing` to either:
 *   - "api_complete"  → go directly to draftDossierNode
 *   - "needs_browser" → go to browserFallbackNode first
 *
 * Falls back to "needs_browser" if the field is missing (defensive default).
 */
function routeAfterApiLookup(
  state: AgentState
): "draftDossierNode" | "browserFallbackNode" {
  const routing = state.apiData?.["__routing"];

  if (routing === "api_complete") {
    console.log("[graph] Route: apiLookupNode → draftDossierNode (API data complete)");
    return "draftDossierNode";
  }

  console.log("[graph] Route: apiLookupNode → browserFallbackNode (browser fallback needed)");
  return "browserFallbackNode";
}

/**
 * Routes after `guardrailNode` based on whether human review is required.
 *
 * `requiresHuman` is set to true by:
 *   - `browserFallbackNode` (on scraping failure or low-confidence extraction)
 *   - `guardrailNode` (when critical claims are unsourced after audit)
 *
 * If `requiresHuman` is true → humanReviewNode (graph pauses here via interruptBefore)
 * Otherwise → END (dossier is finalised automatically)
 */
function routeAfterGuardrail(
  state: AgentState
): "humanReviewNode" | typeof END {
  if (state.requiresHuman) {
    console.log("[graph] Route: guardrailNode → humanReviewNode (HITL required)");
    return "humanReviewNode";
  }

  console.log("[graph] Route: guardrailNode → END (auto-approved)");
  return END;
}

// ---------------------------------------------------------------------------
// Graph assembly — fully chained builder
// ---------------------------------------------------------------------------

/**
 * Builds the StateGraph as a single chained expression.
 *
 * Why chaining is required:
 *   Each `.addNode("name", fn)` call returns a new TypeScript type that
 *   includes "name" in the set of valid node names. If you break the chain
 *   into separate statements (e.g., `graph.addNode(...); graph.addEdge(...)`),
 *   the `addEdge` call operates on the *original* type which has no nodes —
 *   TypeScript will reject any node name string you pass to it.
 *
 *   The fluent chain below ensures that by the time we call `.addEdge()`,
 *   all six nodes are registered in the type, so their names are accepted.
 */
function buildGraph() {
  return (
    new StateGraph(AgentStateAnnotation)

      // --- Node registrations (must come before any edge definitions) ---
      .addNode("ingestDataNode", ingestDataNode)
      .addNode("apiLookupNode", apiLookupNode)
      .addNode("browserFallbackNode", browserFallbackNode)
      .addNode("draftDossierNode", draftDossierNode)
      .addNode("guardrailNode", guardrailNode)
      .addNode("humanReviewNode", humanReviewNode)

      // --- Fixed (unconditional) edges ---
      // Entry: every run starts with data ingestion
      .addEdge(START, "ingestDataNode")
      // After ingest: always run the API lookup
      .addEdge("ingestDataNode", "apiLookupNode")
      // After browser fallback: always proceed to dossier (even on failure —
      // the dossier node handles null browserData gracefully)
      .addEdge("browserFallbackNode", "draftDossierNode")
      // After dossier draft: always run the guardrail audit
      .addEdge("draftDossierNode", "guardrailNode")
      // After human approval: finalise
      .addEdge("humanReviewNode", END)

      // --- Conditional edges ---
      // After API lookup: either go directly to dossier or invoke browser fallback
      .addConditionalEdges("apiLookupNode", routeAfterApiLookup, {
        draftDossierNode: "draftDossierNode",
        browserFallbackNode: "browserFallbackNode",
      })

      // After guardrail: either pause for HITL or auto-finalise
      .addConditionalEdges("guardrailNode", routeAfterGuardrail, {
        humanReviewNode: "humanReviewNode",
        [END]: END,
      })
  );
}

// ---------------------------------------------------------------------------
// Compiled graph (with checkpointer)
// ---------------------------------------------------------------------------

/**
 * `MemorySaver` stores the full graph state in-process memory keyed by
 * `thread_id` (our caseId). This enables the HITL interrupt/resume flow:
 *
 *   1. `compiledGraph.invoke(initialState, { configurable: { thread_id } })`
 *      runs until `interruptBefore: ["humanReviewNode"]` and saves state.
 *   2. State is persisted by MemorySaver — the run pauses, the HTTP handler returns.
 *   3. Human reviewer reads the dossier via GET /cases/:id.
 *   4. Human calls POST /cases/:id/approve — server calls `resumeCaseAfterApproval`.
 *   5. `compiledGraph.invoke(null, { configurable: { thread_id } })` resumes
 *      from the saved checkpoint, runs humanReviewNode → END.
 *
 * Production note: swap `MemorySaver` for a SQLite or Postgres checkpointer
 * (@langchain/langgraph-checkpoint-sqlite / -postgres) when running multiple
 * workers or needing persistence across process restarts.
 */
const checkpointer = new MemorySaver();

/**
 * The compiled, ready-to-run AML/KYC compliance graph.
 *
 * `interruptBefore: ["humanReviewNode"]` tells LangGraph to pause execution
 * BEFORE entering `humanReviewNode`. Control returns to the caller and the
 * current state is saved to the checkpointer. No code inside `humanReviewNode`
 * runs until the graph is explicitly resumed.
 */
export const compiledGraph = buildGraph().compile({
  checkpointer,
  interruptBefore: ["humanReviewNode"],
});

// ---------------------------------------------------------------------------
// Helper exports used by index.ts
// ---------------------------------------------------------------------------

/**
 * Retrieve the current state snapshot for a given case.
 * Used by the GET /cases/:id endpoint.
 */
export async function getCaseState(caseId: string) {
  return compiledGraph.getState({ configurable: { thread_id: caseId } });
}

/**
 * Resume a paused graph after human approval.
 *
 * Passing `null` as the update tells LangGraph to resume from the saved
 * checkpoint without modifying any state values.
 *
 * @param caseId  The thread_id / case identifier (must match the paused run).
 * @param updates Optional state overrides from the human reviewer,
 *                e.g., an upgraded riskScore or reviewer notes in messages.
 */
export async function resumeCaseAfterApproval(
  caseId: string,
  updates: Partial<AgentState> | null = null
) {
  return compiledGraph.invoke(updates, {
    configurable: { thread_id: caseId },
  });
}
