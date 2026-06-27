/**
 * LLM Provider Catalog — single source of truth for model tiers.
 *
 * Each tier maps to a model identifier, cost metadata, and capability flags.
 * The router uses this catalog to select the best provider for each request.
 */

export type LlmTier = "t0" | "t1" | "t2" | "t3" | "t4";

export interface ProviderConfig {
  tier: LlmTier;
  name: string;
  modelId: string;
  /** Approximate cost per 1K input tokens (USD). */
  costPer1kInput: number;
  /** Approximate cost per 1K output tokens (USD). */
  costPer1kOutput: number;
  /** Maximum context window in tokens. */
  maxContextTokens: number;
  /** Whether the provider supports native structured/JSON output. */
  supportsStrictJson: boolean;
  /** LangChain adapter key — used by the router to instantiate the right adapter. */
  adapterKey: "deterministic" | "openai" | "anthropic" | "google" | "ollama";
}

export const PROVIDERS: readonly ProviderConfig[] = [
  {
    tier: "t0",
    name: "Deterministic (rule-based)",
    modelId: "deterministic",
    costPer1kInput: 0,
    costPer1kOutput: 0,
    maxContextTokens: Infinity,
    supportsStrictJson: true,
    adapterKey: "deterministic",
  },
  {
    tier: "t1",
    name: "Ollama Llama 3",
    modelId: "llama3",
    costPer1kInput: 0,
    costPer1kOutput: 0,
    maxContextTokens: 8_192,
    supportsStrictJson: false,
    adapterKey: "ollama",
  },
  {
    tier: "t2",
    name: "GPT-4o-mini",
    modelId: "gpt-4o-mini",
    costPer1kInput: 0.00015,
    costPer1kOutput: 0.0006,
    maxContextTokens: 128_000,
    supportsStrictJson: true,
    adapterKey: "openai",
  },
  {
    tier: "t3",
    name: "Gemini 1.5 Flash",
    modelId: "gemini-1.5-flash",
    costPer1kInput: 0.000075,
    costPer1kOutput: 0.0003,
    maxContextTokens: 1_000_000,
    supportsStrictJson: true,
    adapterKey: "google",
  },
  {
    tier: "t4",
    name: "GPT-4o",
    modelId: "gpt-4o",
    costPer1kInput: 0.0025,
    costPer1kOutput: 0.01,
    maxContextTokens: 128_000,
    supportsStrictJson: true,
    adapterKey: "openai",
  },
] as const;

/** Lookup a provider config by tier. Throws if tier is unknown. */
export function getProvider(tier: LlmTier): ProviderConfig {
  const provider = PROVIDERS.find((p) => p.tier === tier);
  if (provider === undefined) {
    throw new Error(`Unknown LLM tier: ${tier}`);
  }
  return provider;
}
