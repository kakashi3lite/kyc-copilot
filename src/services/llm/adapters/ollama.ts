/**
 * Ollama LangChain adapter — wraps ChatOllama for local dossier drafting.
 *
 * Uses prompt-based JSON extraction (no native structured output).
 * Used for T1 tier — local development with zero cost.
 *
 * Every completed call is reported through {@link reportLlmCall} (audit
 * trail + monthly usage accumulation).
 */

import { ChatOllama } from "@langchain/ollama";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { AgentState } from "../../../graph/state.js";
import type { DossierDraft, LlmClient } from "../client.js";
import type { GraphContext } from "../../kyc-data/graph-query.js";
import type { LlmTier } from "../../../config/llm-providers.js";
import { DossierSchema } from "../../../graph/schemas.js";
import { buildDossierPrompt, estimateTokens } from "./prompt.js";
import { computeCostUsd } from "../cost-tracker.js";
import { reportLlmCall } from "../audit.js";

export class OllamaAdapter implements LlmClient {
  private readonly model: ChatOllama;

  public constructor(
    baseUrl: string,
    private readonly costPer1kInput: number,
    private readonly costPer1kOutput: number,
    private readonly tier: LlmTier,
  ) {
    this.model = new ChatOllama({
      model: "llama3",
      baseUrl,
      temperature: 0,
    });
  }

  public async draftDossier(state: AgentState, graphCtx?: GraphContext | null): Promise<DossierDraft> {
    const promptText = buildDossierPrompt(state, graphCtx);
    const startMs = Date.now();
    const response = await this.model.invoke([
      new SystemMessage(
        "You are a KYC/AML compliance analyst. You MUST respond with ONLY valid JSON matching this schema: " +
        JSON.stringify(DossierSchema.shape) +
        ". No markdown, no explanation, just the JSON object."
      ),
      new HumanMessage(promptText),
    ]);
    const latencyMs = Date.now() - startMs;
    const content = typeof response.content === "string" ? response.content : JSON.stringify(response.content);

    // Ollama reports eval counts in response metadata; fall back to estimate.
    const meta = (response as unknown as { usage_metadata?: { input_tokens?: number; output_tokens?: number } }).usage_metadata;
    const promptTokens = meta?.input_tokens ?? estimateTokens(state);
    const completionTokens = meta?.output_tokens ?? 0;
    const costUsd = computeCostUsd(promptTokens, completionTokens, this.costPer1kInput, this.costPer1kOutput);

    void reportLlmCall({
      tenantId: state.tenantId,
      caseId: state.caseId,
      modelId: "llama3",
      tier: this.tier,
      promptTokens,
      completionTokens,
      costUsd,
      latencyMs,
      cached: false,
    }, promptText, content).catch(() => {});

    return DossierSchema.parse(JSON.parse(content));
  }
}
