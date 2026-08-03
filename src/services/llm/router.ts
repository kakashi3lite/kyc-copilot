/**
 * DynamicLlmRouter — implements LlmClient by selecting the best provider
 * based on task difficulty, cost, and strict-JSON requirements.
 *
 * Pure function `pickModel()` is deterministic and testable.
 * `draftDossier()` integrates, in order:
 *   1. Semantic cache lookup (Sprint 3) — repeat lookups skip the LLM.
 *   2. Per-tenant budget check (Sprint 2) — over-budget tenants fall to t0,
 *      near-budget tenants are capped at t2.
 *   3. Difficulty classifier (Sprint 3) — assigns a cost-optimized tier.
 *   4. Model selection + adapter call, then cache write-back.
 *
 * The router instantiates adapters lazily and falls back to T0 on failure.
 */

import type { AgentState } from "../../graph/state.js";
import type { DossierDraft, LlmClient } from "./client.js";
import { DeterministicLlmClient } from "./client.js";
import { env } from "../../config/env.js";
import { type LlmTier, type ProviderConfig, getProvider } from "../../config/llm-providers.js";
import { checkLlmBudget } from "./budget.js";
import { DeterministicDifficultyClassifier } from "./difficulty-classifier.js";
import { cacheKey, hashCacheKey, sharedCache, type CacheEntry } from "./cache.js";
import { recordTokenUsage } from "./cost-tracker.js";
import type { GraphContext } from "../kyc-data/graph-query.js";
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
      return new OpenAiAdapter(provider.modelId, key, provider.costPer1kInput, provider.costPer1kOutput, provider.tier);
    }

    case "anthropic": {
      const key = env.ANTHROPIC_API_KEY;
      if (!key) {
        log.warn("ANTHROPIC_API_KEY not set, falling back to deterministic");
        return new DeterministicLlmClient();
      }
      const { AnthropicAdapter } = require("./adapters/anthropic.js") as typeof import("./adapters/anthropic.js");
      return new AnthropicAdapter(key, provider.costPer1kInput, provider.costPer1kOutput, provider.tier);
    }

    case "google": {
      const key = env.GOOGLE_API_KEY;
      if (!key) {
        log.warn("GOOGLE_API_KEY not set, falling back to deterministic");
        return new DeterministicLlmClient();
      }
      const { GoogleAdapter } = require("./adapters/google.js") as typeof import("./adapters/google.js");
      return new GoogleAdapter(key, provider.costPer1kInput, provider.costPer1kOutput, provider.tier);
    }

    case "ollama": {
      const { OllamaAdapter } = require("./adapters/ollama.js") as typeof import("./adapters/ollama.js");
      return new OllamaAdapter(env.OLLAMA_BASE_URL, provider.costPer1kInput, provider.costPer1kOutput, provider.tier);
    }

    default:
      log.warn({ adapterKey: provider.adapterKey }, "unknown adapter key, falling back to deterministic");
      return new DeterministicLlmClient();
  }
}

// ── Router class ────────────────────────────────────────────────────────

export class DynamicLlmRouter implements LlmClient {
  private readonly deterministic = new DeterministicLlmClient();

  public async draftDossier(state: AgentState, graphCtx?: GraphContext | null): Promise<DossierDraft> {
    // ── 1. Semantic cache lookup ──────────────────────────────────────────
    // Bypassed for high-risk cases (must always get a fresh assessment),
    // browser-failed cases (incomplete data must not be cached), and in
    // tests (no Redis dependency in CI).
    const cacheEnabled = env.LLM_CACHE_ENABLED && env.NODE_ENV !== "test" && !state.requiresHuman && !state.browserFailed;
    const key = cacheEnabled ? cacheKey(state, graphCtx) : null;
    if (key !== null) {
      const cached = await sharedCache.get(key);
      if (cached) {
        log.info({ promptHash: key.slice(0, 16) }, "cache hit");
        // Record a zero-cost call so the cache-hit benchmark is measurable.
        recordTokenUsage(state.tenantId, 0, 0, 0).catch(() => {});
        return cached.response;
      }
    }

    // ── 2. Budget enforcement ────────────────────────────────────────────
    // Fail-open: if the budget check itself errors (DB down), proceed
    // without a cap rather than blocking the case.
    const budget = await checkLlmBudget(state.tenantId).catch((error) => {
      log.warn({ error: error instanceof Error ? error.message : String(error) }, "budget check failed, proceeding without cap");
      return null;
    });
    if (budget !== null && !budget.allowed) {
      log.warn({ tenantId: state.tenantId, reason: budget.reason }, "budget blocked, routing to t0");
      return this.deterministic.draftDossier(state);
    }

    // ── 3. Difficulty-aware routing ──────────────────────────────────────
    const classifier = new DeterministicDifficultyClassifier();
    const features = classifier.extractFeatures(state);
    const assignment = classifier.classify(features);
    let tier: LlmTier = assignment.tier;
    // Near-budget tenants are capped at t2 — no t4 for them.
    if (budget !== null && budget.allowed && budget.warning && tier === "t4") {
      log.warn({ tenantId: state.tenantId }, "budget at warning threshold, capping t4 → t2");
      tier = "t2";
    }

    const ctx: RoutingContext = {
      configuredTier: tier,
      tokenEstimate: features.estimatedTokenCount,
      nodeRequirement: "strict-zod", // dossier always requires strict schema
    };
    const selected = pickModel(ctx);
    log.info({
      assignedTier: assignment.tier,
      tier: selected.tier,
      confidence: assignment.confidence,
      reason: assignment.reason,
      tokenEstimate: ctx.tokenEstimate,
    }, "model selected for dossier draft");

    // T0 short-circuit — no need for try/catch
    if (selected.tier === "t0") {
      return this.deterministic.draftDossier(state);
    }

    try {
      const adapter = createAdapter(selected);
      const result = await adapter.draftDossier(state, graphCtx);

      // ── 4. Cache write-back ────────────────────────────────────────────
      if (key !== null) {
        const entry: CacheEntry = {
          promptHash: hashCacheKey(state, graphCtx),
          response: result,
          modelId: selected.modelId,
          costSavedUsd: selected.costPer1kInput * (features.estimatedTokenCount / 1000),
          createdAt: new Date().toISOString(),
          ttlSeconds: sharedCache.ttlForState(state),
        };
        await sharedCache.set(entry).catch(() => {});
      }

      return result;
    } catch (error) {
      log.warn(
        { error: error instanceof Error ? error.message : String(error), tier: selected.tier },
        "LLM provider failed, falling back to deterministic (T0)"
      );
      return this.deterministic.draftDossier(state);
    }
  }
}
