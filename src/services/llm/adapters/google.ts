/**
 * Google Gemini LangChain adapter — wraps ChatGoogleGenerativeAI for dossier drafting.
 *
 * Supports strict-JSON via `.withStructuredOutput()`.
 * Used for T3 (gemini-1.5-flash) tier — 1M token context window.
 */

import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { AgentState } from "../../../graph/state.js";
import type { DossierDraft, LlmClient } from "../client.js";
import { DossierSchema } from "../../../graph/schemas.js";
import { buildDossierPrompt } from "./prompt.js";

export class GoogleAdapter implements LlmClient {
  private readonly model: ChatGoogleGenerativeAI;

  public constructor(apiKey: string) {
    this.model = new ChatGoogleGenerativeAI({
      model: "gemini-1.5-flash",
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
