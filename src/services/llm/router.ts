/**
 * DynamicLlmRouter — implements LlmClient by selecting the best provider
 * based on context size, cost, and strict-JSON requirements.
 *
 * Pure function `pickModel()` is deterministic and testable.
 * The router instantiates adapters lazily and falls back to T0 on failure.
 */

import type { AgentState } from "../../graph/state.js";
import type { DossierDraft, LlmClient } from "./client.js";
import { DeterministicLlmClient } from "./client.js";
import { env } from "../../config/env.js";
import { type LlmTier, type ProviderConfig, getProvider } from "../../config/llm-providers.js";
import { estimateTokens } from "./adapters/prompt.js";
import { childLogger } from "../../config/logger.js";

const log = childLogger({ component: "llm-router" });

// ── Routing context ─────────────────────────────────────────────────────

export interface RoutingContext {
  /** The primary tier from env config. */
  configuredTier: LlmTier;
  /** Estimated token count for the input. */
  tokenEstimate: number;
  /** Whether the calling node requires strict Zod-validated JSON. */
  nodeRequirement: "strict-zod" | "best-effort";
}

// ── Pure routing function ───────────────────────────────────────────────

/**
 * Deterministic model selection. Rules (evaluated in order):
 * 1. If strict-zod required and configured tier doesn't support it → T2 or T3.
 * 2. If token estimate > 120K → T3 (Gemini Flash, 1M context).
 * 3. Otherwise → configured tier (default T2).
 */
export function pickModel(ctx: RoutingContext): ProviderConfig {
  const configured = getProvider(ctx.configuredTier);

  // Rule 1: strict-zod enforcement
  if (ctx.nodeRequirement === "strict-zod" && !configured.supportsStrictJson) {
    log.info({ configuredTier: ctx.configuredTier }, "tier lacks strict-json, routing to t2");
    return getProvider("t2");
  }

  // Rule 2: large context → Gemini Flash
  if (ctx.tokenEstimate > 120_000) {
    log.info({ tokenEstimate: ctx.tokenEstimate }, "large context, routing to t3 (Gemini Flash)");
    return getProvider("t3");
  }

  // Rule 3: default to configured tier
  return configured;
}

// ── Adapter factory ─────────────────────────────────────────────────────

function createAdapter(provider: ProviderConfig): LlmClient {
  switch (provider.adapterKey) {
    case "deterministic":
      return new DeterministicLlmClient();

    case "openai": {
      const key = env.OPENAI_API_KEY;
      if (!key) {
        log.warn("OPENAI_API_KEY not set, falling back to deterministic");
        return new DeterministicLlmClient();
      }
      // Lazy import to avoid loading SDK when not needed
      const { OpenAiAdapter } = require("./adapters/openai.js") as typeof import("./adapters/openai.js");
      return new OpenAiAdapter(provider.modelId, key);
    }

    case "anthropic": {
      const key = env.ANTHROPIC_API_KEY;
      if (!key) {
        log.warn("ANTHROPIC_API_KEY not set, falling back to deterministic");
        return new DeterministicLlmClient();
      }
      const { AnthropicAdapter } = require("./adapters/anthropic.js") as typeof import("./adapters/anthropic.js");
      return new AnthropicAdapter(key);
    }

    case "google": {
      const key = env.GOOGLE_API_KEY;
      if (!key) {
        log.warn("GOOGLE_API_KEY not set, falling back to deterministic");
        return new DeterministicLlmClient();
      }
      const { GoogleAdapter } = require("./adapters/google.js") as typeof import("./adapters/google.js");
      return new GoogleAdapter(key);
    }

    case "ollama": {
      const { OllamaAdapter } = require("./adapters/ollama.js") as typeof import("./adapters/ollama.js");
      return new OllamaAdapter(env.OLLAMA_BASE_URL);
    }

    default:
      log.warn({ adapterKey: provider.adapterKey }, "unknown adapter key, falling back to deterministic");
      return new DeterministicLlmClient();
  }
}

// ── Router class ────────────────────────────────────────────────────────

export class DynamicLlmRouter implements LlmClient {
  private readonly deterministic = new DeterministicLlmClient();

  public async draftDossier(state: AgentState): Promise<DossierDraft> {
    const ctx: RoutingContext = {
      configuredTier: env.LLM_TIER_PRIMARY as LlmTier,
      tokenEstimate: estimateTokens(state),
      nodeRequirement: "strict-zod", // dossier always requires strict schema
    };

    const selected = pickModel(ctx);
    log.info({
      tier: selected.tier,
      model: selected.modelId,
      tokenEstimate: ctx.tokenEstimate,
    }, "model selected for dossier draft");

    // T0 short-circuit — no need for try/catch
    if (selected.tier === "t0") {
      return this.deterministic.draftDossier(state);
    }

    try {
      const adapter = createAdapter(selected);
      return await adapter.draftDossier(state);
    } catch (error) {
      log.warn(
        { error: error instanceof Error ? error.message : String(error), tier: selected.tier },
        "LLM provider failed, falling back to deterministic (T0)"
      );
      return this.deterministic.draftDossier(state);
    }
  }
}
