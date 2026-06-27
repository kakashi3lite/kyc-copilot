/**
 * Anthropic LangChain adapter — wraps ChatAnthropic for dossier drafting.
 *
 * Uses prompt-based JSON extraction with Zod parse validation.
 * Used for T2 tier (Claude 3 Haiku fallback).
 */

import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { AgentState } from "../../../graph/state.js";
import type { DossierDraft, LlmClient } from "../client.js";
import { DossierSchema } from "../../../graph/schemas.js";
import { buildDossierPrompt } from "./prompt.js";

export class AnthropicAdapter implements LlmClient {
  private readonly model: ChatAnthropic;

  public constructor(apiKey: string) {
    this.model = new ChatAnthropic({
      model: "claude-3-haiku-20240307",
      anthropicApiKey: apiKey,
      temperature: 0,
      maxRetries: 1,
    });
  }

  public async draftDossier(state: AgentState): Promise<DossierDraft> {
    const response = await this.model.invoke([
      new SystemMessage(
        "You are a KYC/AML compliance analyst. You MUST respond with ONLY valid JSON matching this schema: " +
        JSON.stringify({ claims: "[{id, text, sourceKey}]", riskScore: "Low|Medium|High", summary: "string" }) +
        ". No markdown, no explanation, just the JSON object."
      ),
      new HumanMessage(buildDossierPrompt(state)),
    ]);
    const content = typeof response.content === "string"
      ? response.content
      : JSON.stringify(response.content);
    return DossierSchema.parse(JSON.parse(content));
  }
}
