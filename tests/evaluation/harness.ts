/**
 * Evaluation harness for the Blue Ocean AI subsystems.
 *
 * Every model change runs through this harness before merge. Benchmarks are
 * compared against golden-dataset baselines, and `EvaluationResult.passed`
 * gates the change.
 *
 * Subsystems:
 *   - cost-router    → cost-per-dossier, t0–t2 routing ratio, cache hit rate
 *   - rag-graph      → entity resolution F1, graph query latency
 *   - kyt-classifier → typology precision/recall (deferred, Sprint 6)
 */

export type EvaluationSubsystem = "cost-router" | "rag-graph" | "kyt-classifier";
export type GoldenRiskScore = "Low" | "Medium" | "High";
export type GoldenTier = "t0" | "t2" | "t4";

export interface EvaluationResult {
  subsystem: EvaluationSubsystem;
  metric: string;
  baseline: number;
  current: number;
  delta: number;
  passed: boolean;
}

export interface GoldenCase {
  caseId: string;
  companyName: string;
  registrationNumber: string;
  jurisdiction: string;
  expectedRiskScore: GoldenRiskScore;
  expectedTier: GoldenTier;
  expectedEntityResolved: boolean;
}

export interface GoldenDataset {
  name: string;
  cases: GoldenCase[];
}

/**
 * Produce an {@link EvaluationResult} for a single metric.
 * `passed` is true when `current` meets or beats `baseline` by at least
 * `minImprovement` (which may be negative for cost/latency metrics where a
 * drop is an improvement).
 */
export function evaluateResult(
  subsystem: EvaluationSubsystem,
  metric: string,
  baseline: number,
  current: number,
  minImprovement = 0,
): EvaluationResult {
  const delta = current - baseline;
  return { subsystem, metric, baseline, current, delta, passed: delta >= minImprovement };
}

/**
 * Fraction of LLM call tiers that are low-cost (t0/t1/t2). Benchmark target:
 * ≥ 0.60 of all dossier calls routed to t0–t2.
 */
export function lowCostTierRatio(tiers: ReadonlyArray<"t0" | "t1" | "t2" | "t3" | "t4">): number {
  if (tiers.length === 0) return 0;
  const lowCost = tiers.filter((t) => t === "t0" || t === "t1" || t === "t2").length;
  return lowCost / tiers.length;
}

/**
 * Cache hit rate for a run: cached calls / total LLM calls (cached included).
 * Benchmark target: ≥ 0.15.
 */
export function cacheHitRate(cachedCalls: number, totalCalls: number): number {
  if (totalCalls === 0) return 0;
  return cachedCalls / totalCalls;
}

/**
 * Entity-resolution F1 over a golden dataset: harmonic mean of precision
 * and recall of duplicate-entity merging. Benchmark target: > 0.90.
 */
export function entityResolutionF1(precision: number, recall: number): number {
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Harness v2 — golden-dataset evaluation (PLAN_PRODUCTION_READINESS Phase 2).
 *
 * Golden datasets are synthetic fixtures (ADR-013) that benchmark the REAL
 * production implementations (DeterministicEntityResolver,
 * DeterministicDifficultyClassifier) against recorded expectations. CI fails
 * when any gate regresses. Every dataset is Zod-validated — the `synthetic:
 * true` literal is enforced at parse time so no fixture can be mistaken for
 * production data.
 * ─────────────────────────────────────────────────────────────────────────── */

import { z } from "zod";
import { getProvider, type LlmTier } from "../../src/config/llm-providers.js";

// ── Entity-resolution golden dataset ───────────────────────────────────────

export const EntityPairSchema = z.object({
  sourceName: z.enum(["opencorporates", "complyadvantage", "browser"]),
  legalName: z.string().min(1),
  registrationNumber: z.string().min(1),
  jurisdiction: z.string().length(2),
});
export type EntityPair = z.infer<typeof EntityPairSchema>;

export const EntityResolutionGroupSchema = z.object({
  groupId: z.string().min(1),
  expectedMerge: z.boolean(),
  note: z.string().optional(),
  primary: EntityPairSchema,
  secondary: EntityPairSchema,
});
export type EntityResolutionGroup = z.infer<typeof EntityResolutionGroupSchema>;

export const EntityResolutionGoldenSchema = z.object({
  name: z.string().min(1),
  version: z.number().int().positive(),
  synthetic: z.literal(true), // ADR-013: fixtures never enter production data
  resolverThreshold: z.number().min(0).max(1),
  groups: z.array(EntityResolutionGroupSchema).min(1),
});
export type EntityResolutionGolden = z.infer<typeof EntityResolutionGoldenSchema>;

export interface EntityResolutionMetrics {
  precision: number;
  recall: number;
  f1: number;
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
}

/** Resolve a pair to the browser-source match confidence (0..1), or null when no browser source exists. */
export type PairResolver = (primary: EntityPair, secondary: EntityPair) => number | null;

export function entityResolutionMetrics(
  groups: EntityResolutionGroup[],
  resolve: PairResolver,
  threshold: number,
): EntityResolutionMetrics {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  for (const group of groups) {
    const confidence = resolve(group.primary, group.secondary);
    const predictedMerge = confidence !== null && confidence >= threshold;
    if (group.expectedMerge && predictedMerge) truePositive++;
    else if (!group.expectedMerge && predictedMerge) falsePositive++;
    else if (group.expectedMerge && !predictedMerge) falseNegative++;
  }
  const precision = truePositive + falsePositive === 0 ? 0 : truePositive / (truePositive + falsePositive);
  const recall = truePositive + falseNegative === 0 ? 0 : truePositive / (truePositive + falseNegative);
  return { precision, recall, f1: entityResolutionF1(precision, recall), truePositive, falsePositive, falseNegative };
}

// ── Cost-router golden dataset ─────────────────────────────────────────────

export const RouterFeaturesSchema = z.object({
  jurisdictionRiskScore: z.number().min(0).max(1),
  hasSanctionsHit: z.boolean(),
  hasPepFlag: z.boolean(),
  dataCompleteness: z.number().min(0).max(1),
  uboCount: z.number().int().min(0),
  uboVerifiedFraction: z.number().min(0).max(1),
  evidenceSourceCount: z.number().int().min(0),
  priorCaseCount: z.number().int().min(0),
  estimatedTokenCount: z.number().int().min(0),
});
export type RouterFeatures = z.infer<typeof RouterFeaturesSchema>;

export const RouterGoldenCaseSchema = z.object({
  caseId: z.string().min(1),
  companyName: z.string().min(1),
  jurisdiction: z.string().length(2),
  replayKey: z.string().min(1),
  cacheable: z.boolean(),
  inputTokens: z.number().int().positive(),
  outputTokens: z.number().int().positive(),
  expectedRiskScore: z.enum(["Low", "Medium", "High"]),
  expectedTier: z.enum(["t0", "t1", "t2", "t3", "t4"]),
  features: RouterFeaturesSchema,
});
export type RouterGoldenCase = z.infer<typeof RouterGoldenCaseSchema>;

export const RouterGoldenSchema = z.object({
  name: z.string().min(1),
  version: z.number().int().positive(),
  synthetic: z.literal(true),
  cases: z.array(RouterGoldenCaseSchema).min(1),
});
export type RouterGolden = z.infer<typeof RouterGoldenSchema>;

export type TierClassifier = (features: RouterFeatures) => LlmTier;

export interface RouterEvalMetrics {
  agreement: number;
  lowCostTierRatio: number;
  predictedTiers: LlmTier[];
  mismatches: Array<{ caseId: string; expected: LlmTier; predicted: LlmTier }>;
}

export function routerMetrics(cases: RouterGoldenCase[], classify: TierClassifier): RouterEvalMetrics {
  const predictedTiers = cases.map((c) => classify(c.features));
  const mismatches = cases
    .map((c, i) => ({ caseId: c.caseId, expected: c.expectedTier, predicted: predictedTiers[i] ?? "t2" }))
    .filter((m) => m.predicted !== m.expected);
  return {
    agreement: cases.length === 0 ? 0 : (cases.length - mismatches.length) / cases.length,
    lowCostTierRatio: lowCostTierRatio(predictedTiers),
    predictedTiers,
    mismatches,
  };
}

/** Offline cache-potential over a golden workload (no Redis needed in CI). */
export function simulateCacheHits(cases: RouterGoldenCase[]): { cachedCalls: number; totalCalls: number; rate: number } {
  const seen = new Set<string>();
  let cachedCalls = 0;
  for (const c of cases) {
    if (c.cacheable) {
      if (seen.has(c.replayKey)) cachedCalls++;
      seen.add(c.replayKey);
    }
  }
  return { cachedCalls, totalCalls: cases.length, rate: cacheHitRate(cachedCalls, cases.length) };
}

/** Per-dossier LLM cost at a tier, from the PROVIDERS catalog. */
export function costUsdForTier(tier: LlmTier, inputTokens: number, outputTokens: number): number {
  const provider = getProvider(tier);
  return (inputTokens * provider.costPer1kInput + outputTokens * provider.costPer1kOutput) / 1000;
}

export function estimateDossierCost(cases: RouterGoldenCase[], predictedTiers: LlmTier[]): number {
  return cases.reduce((sum, c, i) => sum + costUsdForTier(predictedTiers[i] ?? "t2", c.inputTokens, c.outputTokens), 0);
}

/** Worst-case cost if every dossier ran on the most expensive tier. */
export function allAtTierCost(cases: RouterGoldenCase[], tier: LlmTier): number {
  return cases.reduce((sum, c) => sum + costUsdForTier(tier, c.inputTokens, c.outputTokens), 0);
}

/** Cost metrics improve when current <= baseline (a drop is an improvement). */
export function evaluateCostResult(
  subsystem: EvaluationSubsystem,
  metric: string,
  baseline: number,
  current: number,
): EvaluationResult {
  return { subsystem, metric, baseline, current, delta: current - baseline, passed: current <= baseline };
}

// ── Evaluation report (deterministic, Zod-validated) ──────────────────────

export const EvaluationReportSchema = z.object({
  generatedAt: z.string(),
  synthetic: z.literal(true),
  results: z.array(
    z.object({
      subsystem: z.enum(["cost-router", "rag-graph", "kyt-classifier"]),
      metric: z.string().min(1),
      baseline: z.number(),
      current: z.number(),
      delta: z.number(),
      passed: z.boolean(),
    }),
  ),
});
export type EvaluationReport = z.infer<typeof EvaluationReportSchema>;

export function serializeReport(report: EvaluationReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

// ── KYT golden dataset & metrics (Phase 3) ──────────────────────────────────

export const KytGoldenSchema = z.object({
  name: z.string().min(1),
  version: z.number().int().positive(),
  synthetic: z.literal(true),
  wallets: z.array(
    z.object({
      walletId: z.string().min(1),
      profile: z.string().min(1),
      seed: z.number().int(),
      expectedTypology: z.enum(["cybercrime_dispersion", "sanctions_evasion", "mixing", "clean"]),
    }),
  ).min(1),
});
export type KytGolden = z.infer<typeof KytGoldenSchema>;

export interface KytClassMetrics {
  precision: number;
  recall: number;
  f1: number;
  support: number;
}

export interface KytMetrics {
  accuracy: number;
  macroF1: number;
  falsePositiveRate: number;
  perClass: Record<string, KytClassMetrics>;
}

/** Typology classes included in macro-F1 (excludes the `unknown` catch-all). */
const KYT_CLASSES = ["cybercrime_dispersion", "sanctions_evasion", "mixing", "clean"] as const;

/**
 * Macro-F1 (mean of per-class F1 across the four labeled typologies) plus
 * the clean-class false-positive rate. Benchmark targets: macro-F1 > 0.85,
 * FPR < 5%.
 */
export function kytMetrics(
  predictions: ReadonlyArray<{ walletId: string; predicted: string }>,
  goldens: ReadonlyArray<{ walletId: string; expected: string }>,
): KytMetrics {
  const expected = new Map(goldens.map((g) => [g.walletId, g.expected]));
  const perClass: Record<string, KytClassMetrics> = {};
  let correct = 0;
  for (const cls of KYT_CLASSES) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const p of predictions) {
      const exp = expected.get(p.walletId);
      if (exp === undefined) continue;
      if (exp === cls && p.predicted === cls) tp++;
      else if (exp !== cls && p.predicted === cls) fp++;
      else if (exp === cls && p.predicted !== cls) fn++;
    }
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    perClass[cls] = { precision, recall, f1: entityResolutionF1(precision, recall), support: tp + fn };
    correct += tp;
  }

  const total = predictions.filter((p) => expected.has(p.walletId)).length;
  const cleanExpected = goldens.filter((g) => g.expected === "clean").length;
  let cleanFalsePositives = 0;
  for (const p of predictions) {
    if (expected.get(p.walletId) === "clean" && p.predicted !== "clean") cleanFalsePositives++;
  }

  const macroF1 = KYT_CLASSES.reduce((sum, cls) => sum + perClass[cls]!.f1, 0) / KYT_CLASSES.length;
  return {
    accuracy: total === 0 ? 0 : correct / total,
    macroF1,
    falsePositiveRate: cleanExpected === 0 ? 0 : cleanFalsePositives / cleanExpected,
    perClass,
  };
}
