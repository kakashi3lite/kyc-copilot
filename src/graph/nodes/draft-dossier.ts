import type { LlmClient } from "../../services/llm/client.js";
import type { AgentState, AgentStatePatch } from "../state.js";
import type { RiskScore } from "../../types/index.js";
import { DossierSchema } from "../schemas.js";
import { sanitizeOutput } from "../../utils/mask.js";
import { DeterministicEntityResolver } from "../../services/kyc-data/entity-resolver.js";
import { PostgresGraphQueryService, type GraphQueryService } from "../../services/kyc-data/graph-query.js";
import { childLogger } from "../../config/logger.js";

export interface DraftDossierDependencies {
  llm: LlmClient;
  /**
   * Knowledge-graph query service (Sprint 5). Injectable for tests; defaults
   * to the Postgres-backed service. Graph access is best-effort — a failure
   * must never block the dossier.
   */
  graphQuery?: GraphQueryService;
}

const log = childLogger({ component: "draft-dossier-node" });

/**
 * Sanitize every free-text field of a parsed DossierDraft before it is
 * persisted. LLM output lands in `cases.dossier` (plaintext) and is
 * rendered in the dashboard, so dangerous constructs (a hallucinated
 * `<script>` block or `javascript:` URL) must never survive to the
 * client — stored-XSS guard (Sprint 1).
 */
function sanitizeDossierResult(result: { summary: string; claims: Array<{ id: string; text: string; sourceKey: string }>; riskScore: RiskScore }): { summary: string; claims: Array<{ id: string; text: string; sourceKey: string }>; riskScore: RiskScore } {
  return {
    ...result,
    summary: sanitizeOutput(result.summary),
    claims: result.claims.map((claim) => ({ ...claim, text: sanitizeOutput(claim.text) })),
  };
}

export async function draftDossierNode(state: AgentState, deps: DraftDossierDependencies): Promise<AgentStatePatch> {
  const graphQuery = deps.graphQuery ?? new PostgresGraphQueryService();
  const resolver = new DeterministicEntityResolver();

  // ── Entity resolution + graph context (best-effort, fail-open) ──────────
  // The graph only reaches this node after apiLookup has populated
  // `apiData` (the edges gate on completeness), so the non-null assertion
  // is safe. Upsert is fire-and-forget; context is awaited before the LLM
  // call so the prompt can cite cross-case evidence. Any DB failure drops
  // the graph context (and skips the link) without failing the case.
  const resolved = resolver.resolve(state.apiData!, state.browserResult?.data ?? null);
  const entityIdPromise = graphQuery
    .upsertEntity(resolved, state.tenantId)
    .catch(() => "");
  const graphCtxPromise = graphQuery
    .getContext(state.tenantId, state.caseId, resolved.canonicalName, resolved.jurisdiction)
    .catch((error) => {
      log.warn({ error: error instanceof Error ? error.message : String(error) }, "graph context unavailable; continuing without it");
      return null;
    });

  // ── LLM call with graph-enhanced prompt ─────────────────────────────────
  const result = sanitizeDossierResult(DossierSchema.parse(await deps.llm.draftDossier(state, await graphCtxPromise)));

  // Link the case to its canonical entity (best-effort).
  const entityId = await entityIdPromise;
  if (entityId !== "") {
    await graphQuery.linkCaseToEntity(state.caseId, entityId, "subject").catch(() => {});
  }

  const graphCtx = await graphCtxPromise;
  const graphNote = graphCtx && !graphCtx.entityResolution.isNewEntity
    ? `\n[Graph: ${graphCtx.priorCases.length} prior case(s), ${graphCtx.relatedEntities.length} related entities]`
    : "";

  const dossier = [
    `Enhanced Due Diligence dossier for ${state.companyName}. [Source: API_1]${graphNote}`,
    result.summary,
    ...result.claims.map((claim) => `- ${claim.text} [Source: ${claim.sourceKey}]`)
  ].join("\n");
  return { claims: result.claims, dossier, riskScore: result.riskScore };
}
