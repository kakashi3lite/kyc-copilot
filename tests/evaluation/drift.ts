/**
 * Drift detection for the AI subsystems (Phase 5 / Blue Ocean P8).
 *
 * A deterministic snapshot of the golden-dataset behavior (router tier
 * distribution + tier agreement + low-cost ratio + entity-resolution F1)
 * is compared against a recorded baseline. Drift fires when any tier's
 * share moves > 10 points, agreement drops below 0.85, the low-cost ratio
 * drops below 0.60, or entity F1 drops below 0.90 — surfacing accidental
 * classifier/resolver regressions early, before they reach production.
 *
 * Golden datasets are regression baselines by design (ADR-021); this is the
 * weekly tripwire that detects when a change moved them.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { DeterministicDifficultyClassifier } from "../../src/services/llm/difficulty-classifier.js";
import { DeterministicEntityResolver } from "../../src/services/kyc-data/entity-resolver.js";
import type { ApiCompanyData } from "../../src/types/index.js";
import {
  EntityResolutionGoldenSchema,
  RouterGoldenSchema,
  entityResolutionMetrics,
  routerMetrics,
  type EntityPair,
  type RouterFeatures,
} from "./harness.js";
import type { LlmTier } from "../../src/config/llm-providers.js";

export const TierDistributionSchema = z.object({
  t0: z.number().int().min(0),
  t1: z.number().int().min(0),
  t2: z.number().int().min(0),
  t3: z.number().int().min(0),
  t4: z.number().int().min(0),
  total: z.number().int().min(1),
  agreement: z.number().min(0).max(1),
  lowCostRatio: z.number().min(0).max(1),
  entityResolutionF1: z.number().min(0).max(1),
});
export type TierDistribution = z.infer<typeof TierDistributionSchema>;

export interface DriftThresholds {
  maxTierShareDelta: number;
  minAgreement: number;
  minLowCostRatio: number;
  minEntityResolutionF1: number;
}

export const DEFAULT_DRIFT_THRESHOLDS: DriftThresholds = {
  maxTierShareDelta: 0.1,
  minAgreement: 0.85,
  minLowCostRatio: 0.6,
  minEntityResolutionF1: 0.9,
};

export interface DriftResult {
  passed: boolean;
  alerts: string[];
}

export function detectDrift(
  current: TierDistribution,
  baseline: TierDistribution,
  thresholds: DriftThresholds = DEFAULT_DRIFT_THRESHOLDS,
): DriftResult {
  const alerts: string[] = [];
  const tiers = ["t0", "t1", "t2", "t3", "t4"] as const;
  for (const tier of tiers) {
    const curShare = current.total > 0 ? current[tier] / current.total : 0;
    const baseShare = baseline.total > 0 ? baseline[tier] / baseline.total : 0;
    if (Math.abs(curShare - baseShare) > thresholds.maxTierShareDelta) {
      alerts.push(`tier ${tier} share shifted ${baseShare.toFixed(3)} -> ${curShare.toFixed(3)}`);
    }
  }
  if (current.agreement < thresholds.minAgreement) {
    alerts.push(`tier agreement ${current.agreement.toFixed(3)} below ${thresholds.minAgreement}`);
  }
  if (current.lowCostRatio < thresholds.minLowCostRatio) {
    alerts.push(`low-cost tier ratio ${current.lowCostRatio.toFixed(3)} below ${thresholds.minLowCostRatio}`);
  }
  if (current.entityResolutionF1 < thresholds.minEntityResolutionF1) {
    alerts.push(`entity-resolution F1 ${current.entityResolutionF1.toFixed(3)} below ${thresholds.minEntityResolutionF1}`);
  }
  return { passed: alerts.length === 0, alerts };
}

const classifier = new DeterministicDifficultyClassifier();
const resolver = new DeterministicEntityResolver();

const classifyTier: (f: RouterFeatures) => LlmTier = (f) => classifier.classify(f).tier;

const resolvePair: (a: EntityPair, b: EntityPair) => number | null = (a, b) => {
  const resolved = resolver.resolve(a as unknown as ApiCompanyData, b as unknown as ApiCompanyData);
  const browser = resolved.sources.find((s) => s.sourceName === "browser");
  return browser?.matchConfidence ?? null;
};

const DATASETS = resolve(process.cwd(), "tests", "evaluation", "datasets");

/** Compute the current deterministic snapshot over the golden datasets. */
export function buildDriftSnapshot(): TierDistribution {
  const routerRaw = readFileSync(resolve(DATASETS, "cost-router-golden.json"), "utf8");
  const routerDs = RouterGoldenSchema.parse(JSON.parse(routerRaw));
  const m = routerMetrics(routerDs.cases, classifyTier);

  const counts: Record<string, number> = { t0: 0, t1: 0, t2: 0, t3: 0, t4: 0 };
  for (const tier of m.predictedTiers) counts[tier] = (counts[tier] ?? 0) + 1;

  const entityRaw = readFileSync(resolve(DATASETS, "entity-resolution-golden.json"), "utf8");
  const entityDs = EntityResolutionGoldenSchema.parse(JSON.parse(entityRaw));
  const em = entityResolutionMetrics(entityDs.groups, resolvePair, entityDs.resolverThreshold);

  return TierDistributionSchema.parse({
    t0: counts["t0"]!,
    t1: counts["t1"]!,
    t2: counts["t2"]!,
    t3: counts["t3"]!,
    t4: counts["t4"]!,
    total: routerDs.cases.length,
    agreement: m.agreement,
    lowCostRatio: m.lowCostTierRatio,
    entityResolutionF1: em.f1,
  });
}

export function loadDriftBaseline(
  path = resolve(process.cwd(), "tests", "evaluation", "drift-baseline.json"),
): TierDistribution | null {
  try {
    return TierDistributionSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}
