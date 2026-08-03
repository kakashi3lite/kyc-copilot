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
