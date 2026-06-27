/**
 * OpenAI LangChain adapter — wraps ChatOpenAI for dossier drafting.
 *
 * Supports strict-JSON via `.withStructuredOutput()`.
 * Used for T2 (gpt-4o-mini) and T4 (gpt-4o) tiers.
 */

import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { AgentState } from "../../../graph/state.js";
import type { DossierDraft, LlmClient } from "../client.js";
import { DossierSchema } from "../../../graph/schemas.js";
import { buildDossierPrompt } from "./prompt.js";

export class OpenAiAdapter implements LlmClient {
  private readonly model: ChatOpenAI;

  public constructor(modelId: string, apiKey: string) {
    this.model = new ChatOpenAI({
      model: modelId,
      apiKey,
      temperature: 0,
      maxRetries: 1,
    });
  }

  public async draftDossier(state: AgentState): Promise<DossierDraft> {
    const structured = this.model.withStructuredOutput(DossierSchema);
    const result = await structured.invoke([
      new SystemMessage("You are a KYC/AML compliance analyst. Output a structured dossier as JSON."),
      new HumanMessage(buildDossierPrompt(state)),
    ]);
    return result as DossierDraft;
  }
}
