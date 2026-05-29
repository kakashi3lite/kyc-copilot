import type { AgentState } from "../../graph/state.js";
import type { DossierDraft, LlmClient } from "./client.js";
import { DeterministicLlmClient } from "./client.js";
import { childLogger } from "../../config/logger.js";

export class FallbackLlmClient implements LlmClient {
  private readonly providers: LlmClient[];
  public constructor(providers: LlmClient[] = [new DeterministicLlmClient()]) { this.providers = providers; }
  public async draftDossier(state: AgentState): Promise<DossierDraft> {
    let lastError: unknown;
    for (const provider of this.providers) {
      try { return await provider.draftDossier(state); } catch (error) { lastError = error; childLogger({ component: "llm" }).warn({ error: error instanceof Error ? error.message : String(error) }, "llm provider failed"); }
    }
    throw lastError instanceof Error ? lastError : new Error("All LLM providers failed");
  }
}
