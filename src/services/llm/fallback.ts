import type { AgentState } from "../../graph/state.js";
import type { DossierDraft, LlmClient } from "./client.js";
import { DynamicLlmRouter } from "./router.js";
import { childLogger } from "../../config/logger.js";

/**
 * FallbackLlmClient — thin wrapper delegating to DynamicLlmRouter.
 *
 * Preserves the existing constructor signature used by graph-runner.ts.
 * The router handles tier selection and provider fallback internally.
 */
export class FallbackLlmClient implements LlmClient {
  private readonly router: LlmClient;

  public constructor(router?: LlmClient) {
    this.router = router ?? new DynamicLlmRouter();
  }

  public async draftDossier(state: AgentState): Promise<DossierDraft> {
    try {
      return await this.router.draftDossier(state);
    } catch (error) {
      childLogger({ component: "llm" }).warn(
        { error: error instanceof Error ? error.message : String(error) },
        "llm router failed"
      );
      throw error instanceof Error ? error : new Error("All LLM providers failed");
    }
  }
}
