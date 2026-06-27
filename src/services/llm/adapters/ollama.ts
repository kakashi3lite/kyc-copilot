/**
 * Ollama LangChain adapter — wraps ChatOllama for local dossier drafting.
 *
 * Uses prompt-based JSON extraction (no native structured output).
 * Used for T1 tier — local development with zero cost.
 */

import { ChatOllama } from "@langchain/ollama";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { AgentState } from "../../../graph/state.js";
import type { DossierDraft, LlmClient } from "../client.js";
import { DossierSchema } from "../../../graph/schemas.js";
import { buildDossierPrompt } from "./prompt.js";

export class OllamaAdapter implements LlmClient {
  private readonly model: ChatOllama;

  public constructor(baseUrl: string) {
    this.model = new ChatOllama({
      model: "llama3",
      baseUrl,
      temperature: 0,
    });
  }

  public async draftDossier(state: AgentState): Promise<DossierDraft> {
    const response = await this.model.invoke([
      new SystemMessage(
        "You are a KYC/AML compliance analyst. You MUST respond with ONLY valid JSON matching this schema: " +
        JSON.stringify(DossierSchema.shape) +
        ". No markdown, no explanation, just the JSON object."
      ),
      new HumanMessage(buildDossierPrompt(state)),
    ]);
    const content = typeof response.content === "string" ? response.content : JSON.stringify(response.content);
    return DossierSchema.parse(JSON.parse(content));
  }
}
