/**
 * OpenAI LangChain adapter — wraps ChatOpenAI for dossier drafting.
 *
 * Supports strict-JSON via `.withStructuredOutput()`.
 * Used for T2 (gpt-4o-mini) and T4 (gpt-4o) tiers.
 *
 * Every completed call is reported through {@link reportLlmCall} (audit
 * trail + monthly usage accumulation). Token counts come from the model's
 * `usage_metadata` when present, with a heuristic fallback so cost tracking
 * is never silently zero.
 */

import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { AgentState } from "../../../graph/state.js";
import type { DossierDraft, LlmClient } from "../client.js";
import type { GraphContext } from "../../kyc-data/graph-query.js";
import type { LlmTier } from "../../../config/llm-providers.js";
import { DossierSchema } from "../../../graph/schemas.js";
import { buildDossierPrompt, estimateTokens } from "./prompt.js";
import { computeCostUsd } from "../cost-tracker.js";
import { reportLlmCall } from "../audit.js";

export class OpenAiAdapter implements LlmClient {
  private readonly model: ChatOpenAI;

  public constructor(
    private readonly modelId: string,
    apiKey: string,
    private readonly costPer1kInput: number,
    private readonly costPer1kOutput: number,
    private readonly tier: LlmTier,
  ) {
    this.model = new ChatOpenAI({
      model: modelId,
      apiKey,
      temperature: 0,
      maxRetries: 1,
    });
  }

  public async draftDossier(state: AgentState, graphCtx?: GraphContext | null): Promise<DossierDraft> {
    const promptText = buildDossierPrompt(state, graphCtx);
    const structured = this.model.withStructuredOutput(DossierSchema);
    const startMs = Date.now();
    const result = await structured.invoke([
      new SystemMessage("You are a KYC/AML compliance analyst. Output a structured dossier as JSON."),
      new HumanMessage(promptText),
    ]);
    const latencyMs = Date.now() - startMs;

    // Token usage from LangChain response metadata; fall back to the
    // heuristic estimate so cost/audit bookkeeping is never zero-filled.
    const meta = (result as unknown as { usage_metadata?: { input_tokens?: number; output_tokens?: number } }).usage_metadata;
    const promptTokens = meta?.input_tokens ?? estimateTokens(state);
    const completionTokens = meta?.output_tokens ?? 0;
    const costUsd = computeCostUsd(promptTokens, completionTokens, this.costPer1kInput, this.costPer1kOutput);

    // Fire-and-forget — audit + cost bookkeeping must never block the dossier.
    void reportLlmCall({
      tenantId: state.tenantId,
      caseId: state.caseId,
      modelId: this.modelId,
      tier: this.tier,
      promptTokens,
      completionTokens,
      costUsd,
      latencyMs,
      cached: false,
    }, promptText, JSON.stringify(result)).catch(() => {});

    return result as DossierDraft;
  }
}
