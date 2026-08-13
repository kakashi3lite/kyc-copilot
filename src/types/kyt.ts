/**
 * KYT (Know-Your-Transaction) types — Phase 3.
 *
 * Typed contracts for the wallet-transaction typology classifier. Every
 * value entering or leaving the classifier passes through these Zod
 * schemas (ADR-007) — no untyped data ever flows into graph state.
 */

import { z } from "zod";

export const WalletTransactionSchema = z.object({
  txId: z.string().min(1),
  timestamp: z.string(), // ISO-8601
  valueUsd: z.number().min(0),
  direction: z.enum(["in", "out"]),
  counterparty: z.string().min(1),
});
export type WalletTransaction = z.infer<typeof WalletTransactionSchema>;

/** Laundering/dispersion typologies (StableAML + FATF-style descriptors). */
export const KytTypologySchema = z.enum([
  "cybercrime_dispersion",
  "sanctions_evasion",
  "mixing",
  "clean",
  "unknown",
]);
export type KytTypology = z.infer<typeof KytTypologySchema>;

/** Classifiable profiles — the four labeled typologies (excludes `unknown`). */
export type KytProfileName = Exclude<KytTypology, "unknown">;

/** Aggregated, normalized transaction features (all deterministic). */
export const KytFeaturesSchema = z.object({
  txCount: z.number().int().min(0),
  totalValueUsd: z.number().min(0),
  meanValueUsd: z.number().min(0),
  stddevValueUsd: z.number().min(0),
  /** Largest single tx as a fraction of total value. */
  maxSingleValueRatio: z.number().min(0).max(1),
  /** Fraction of txs with values rounded to 100 (round-number structuring). */
  roundNumberRatio: z.number().min(0).max(1),
  /** Txs per calendar day spanned. */
  dailyFrequency: z.number().min(0),
  /** Max txs in any single 1-hour window. */
  peakHourlyVelocity: z.number().int().min(0),
  /** Unique counterparties / tx count (0..1). */
  counterpartyDiversity: z.number().min(0).max(1),
  uniqueCounterparties: z.number().int().min(0),
  /** Shannon entropy of hour-of-day distribution, normalized to 0..1. */
  timeOfDayEntropy: z.number().min(0).max(1),
  /** Fraction of txs just under the structured-split threshold. */
  structuredSplitRatio: z.number().min(0).max(1),
  /** Mean inter-transaction gap in hours. */
  averageGapHours: z.number().min(0),
  /** 1 = perfectly balanced in/out, 0 = fully one-directional. */
  inOutBalance: z.number().min(0).max(1),
});
export type KytFeatures = z.infer<typeof KytFeaturesSchema>;

/** Per-signal contribution — the interpretability requirement (SHAP-style). */
export const KytFeatureContributionSchema = z.object({
  feature: z.string(),
  weight: z.number().min(0),
  rationale: z.string(),
});
export type KytFeatureContribution = z.infer<typeof KytFeatureContributionSchema>;

export const KytVerdictSchema = z.object({
  typology: KytTypologySchema,
  /** Margin between the winning typology and the runner-up (0..1). */
  confidence: z.number().min(0).max(1),
  /** Risk score 0..1 (feeds the ABAC/guardrail risk vector). */
  score: z.number().min(0).max(1),
  triggeredRules: z.array(z.string()),
  contributions: z.array(KytFeatureContributionSchema),
  generatedAt: z.string(),
});
export type KytVerdict = z.infer<typeof KytVerdictSchema>;
