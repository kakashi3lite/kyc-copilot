/**
 * Anthropic LangChain adapter — wraps ChatAnthropic for dossier drafting.
 *
 * Uses prompt-based JSON extraction with Zod parse validation.
 * Used for T2 tier (Claude 3 Haiku fallback).
 *
 * Every completed call is reported through {@link reportLlmCall} (audit
 * trail + monthly usage accumulation).
 */

import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { AgentState } from "../../../graph/state.js";
import type { DossierDraft, LlmClient } from "../client.js";
import type { GraphContext } from "../../kyc-data/graph-query.js";
import type { LlmTier } from "../../../config/llm-providers.js";
import { DossierSchema } from "../../../graph/schemas.js";
import { buildDossierPrompt, estimateTokens } from "./prompt.js";
import { computeCostUsd } from "../cost-tracker.js";
import { reportLlmCall } from "../audit.js";

export class AnthropicAdapter implements LlmClient {
  private readonly model: ChatAnthropic;

  public constructor(
    apiKey: string,
    private readonly costPer1kInput: number,
    private readonly costPer1kOutput: number,
    private readonly tier: LlmTier,
  ) {
    this.model = new ChatAnthropic({
      model: "claude-3-haiku-20240307",
      anthropicApiKey: apiKey,
      temperature: 0,
      maxRetries: 1,
    });
  }

  public async draftDossier(state: AgentState, graphCtx?: GraphContext | null): Promise<DossierDraft> {
    const promptText = buildDossierPrompt(state, graphCtx);
    const startMs = Date.now();
    const response = await this.model.invoke([
      new SystemMessage(
        "You are a KYC/AML compliance analyst. You MUST respond with ONLY valid JSON matching this schema: " +
        JSON.stringify({ claims: "[{id, text, sourceKey}]", riskScore: "Low|Medium|High", summary: "string" }) +
        ". No markdown, no explanation, just the JSON object."
      ),
      new HumanMessage(promptText),
    ]);
    const latencyMs = Date.now() - startMs;
    const content = typeof response.content === "string"
      ? response.content
      : JSON.stringify(response.content);

    // Anthropic exposes usage in response_metadata; fall back to estimate.
    const meta = (response as unknown as { usage_metadata?: { input_tokens?: number; output_tokens?: number } }).usage_metadata;
    const promptTokens = meta?.input_tokens ?? estimateTokens(state);
    const completionTokens = meta?.output_tokens ?? 0;
    const costUsd = computeCostUsd(promptTokens, completionTokens, this.costPer1kInput, this.costPer1kOutput);

    void reportLlmCall({
      tenantId: state.tenantId,
      caseId: state.caseId,
      modelId: "claude-3-haiku-20240307",
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
