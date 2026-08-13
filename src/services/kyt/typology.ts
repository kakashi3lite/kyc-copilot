/**
 * KYT typology classifier — Phase 3 (ADR-021).
 *
 * Deterministic, rule-based baseline implementing the StableAML typology
 * descriptors: cybercrime dispersion (high-velocity, diverse counterparty
 * fan-out), sanctions evasion (structured amounts near reporting
 * thresholds, constrained counterparties, steady cadence), and mixing
 * (obfuscated, entropy-heavy, balanced flows). `clean` is the retail
 * baseline.
 *
 * Design decision (ADR-021): this rule-based baseline ships FIRST because
 * it is interpretable (every verdict carries per-signal contributions),
 * CPU-only, dependency-free, and costs $0.00 marginal LLM spend. The ONNX
 * tree-ensemble is deferred until real transaction data or the golden
 * benchmark proves this baseline insufficient — never add a dependency
 * the team doesn't understand for a model that doesn't beat the baseline.
 *
 * Output is a `KytVerdict` (Zod-validated): typology, confidence (margin
 * between winner and runner-up), risk score, and per-signal contributions
 * — the interpretability requirement for regulated environments.
 */

import { KytVerdictSchema, type KytFeatureContribution, type KytFeatures, type KytTypology, type KytVerdict } from "../../types/kyt.js";
import { round2 } from "./features.js";

/** Below this, no typology is confident — the verdict stays `unknown`. */
const MIN_CONFIDENT_SCORE = 0.3;

/**
 * Minimum confidence for the guardrail to escalate a non-clean typology to
 * HITL. Data-driven (measured on the synthetic golden set, 2026-08-13):
 * risk-typology confidences range 0.38–0.70 (mixing 0.38, cybercrime
 * 0.45–0.55, sanctions 0.50–0.70). 0.30 sits below the observed minimum
 * with margin; clean wallets are excluded by typology, not confidence.
 */
export const KYT_ESCALATION_MIN_CONFIDENCE = 0.3;

const RISK_SCORE: Record<"clean" | "cybercrime_dispersion" | "sanctions_evasion" | "mixing", number> = {
  clean: 0.05,
  sanctions_evasion: 0.75,
  cybercrime_dispersion: 0.85,
  mixing: 0.55,
};

interface TypologyScore {
  typology: KytTypology;
  score: number;
  contributions: KytFeatureContribution[];
}

function scoreCybercrime(f: KytFeatures): TypologyScore {
  const contributions: KytFeatureContribution[] = [];
  let score = 0;
  if (f.counterpartyDiversity >= 0.35) { score += 0.35; contributions.push({ feature: "counterpartyDiversity", weight: 0.35, rationale: "high counterparty dispersion (fan-out)" }); }
  if (f.peakHourlyVelocity >= 5) { score += 0.3; contributions.push({ feature: "peakHourlyVelocity", weight: 0.3, rationale: "bursty hourly velocity" }); }
  if (f.dailyFrequency >= 8) { score += 0.2; contributions.push({ feature: "dailyFrequency", weight: 0.2, rationale: "high daily frequency" }); }
  if (f.roundNumberRatio < 0.4) { score += 0.15; contributions.push({ feature: "roundNumberRatio", weight: 0.15, rationale: "no round-number structuring" }); }
  return { typology: "cybercrime_dispersion", score: round2(score), contributions };
}

function scoreSanctions(f: KytFeatures): TypologyScore {
  const contributions: KytFeatureContribution[] = [];
  let score = 0;
  if (f.structuredSplitRatio >= 0.4) { score += 0.4; contributions.push({ feature: "structuredSplitRatio", weight: 0.4, rationale: "amounts structured just under reporting threshold" }); }
  if (f.roundNumberRatio >= 0.5) { score += 0.25; contributions.push({ feature: "roundNumberRatio", weight: 0.25, rationale: "round-number prevalence" }); }
  if (f.counterpartyDiversity <= 0.3) { score += 0.25; contributions.push({ feature: "counterpartyDiversity", weight: 0.25, rationale: "constrained counterparty set" }); }
  if (f.dailyFrequency <= 4) { score += 0.1; contributions.push({ feature: "dailyFrequency", weight: 0.1, rationale: "steady low cadence" }); }
  return { typology: "sanctions_evasion", score: round2(score), contributions };
}

function scoreMixing(f: KytFeatures): TypologyScore {
  const contributions: KytFeatureContribution[] = [];
  let score = 0;
  if (f.timeOfDayEntropy >= 0.8) { score += 0.35; contributions.push({ feature: "timeOfDayEntropy", weight: 0.35, rationale: "time-of-day obfuscation" }); }
  if (f.counterpartyDiversity >= 0.3) { score += 0.2; contributions.push({ feature: "counterpartyDiversity", weight: 0.2, rationale: "diverse counterparties" }); }
  if (f.roundNumberRatio >= 0.4) { score += 0.2; contributions.push({ feature: "roundNumberRatio", weight: 0.2, rationale: "round-value prevalence" }); }
  if (f.inOutBalance >= 0.5) { score += 0.25; contributions.push({ feature: "inOutBalance", weight: 0.25, rationale: "balanced in/out flow" }); }
  return { typology: "mixing", score: round2(score), contributions };
}

function scoreClean(f: KytFeatures): TypologyScore {
  const contributions: KytFeatureContribution[] = [{ feature: "baseline", weight: 0.15, rationale: "retail-like baseline" }];
  let score = 0.15;
  if (f.peakHourlyVelocity < 2) { score += 0.2; contributions.push({ feature: "peakHourlyVelocity", weight: 0.2, rationale: "low velocity" }); }
  if (f.counterpartyDiversity <= 0.3) { score += 0.15; contributions.push({ feature: "counterpartyDiversity", weight: 0.15, rationale: "few counterparties" }); }
  if (f.dailyFrequency <= 2) { score += 0.2; contributions.push({ feature: "dailyFrequency", weight: 0.2, rationale: "low frequency" }); }
  if (f.roundNumberRatio < 0.3) { score += 0.15; contributions.push({ feature: "roundNumberRatio", weight: 0.15, rationale: "natural value distribution" }); }
  if (f.structuredSplitRatio < 0.2) { score += 0.15; contributions.push({ feature: "structuredSplitRatio", weight: 0.15, rationale: "no structured amounts" }); }
  return { typology: "clean", score: round2(score), contributions };
}

export function classify(features: KytFeatures): KytVerdict {
  if (features.txCount === 0) {
    return KytVerdictSchema.parse({
      typology: "unknown",
      confidence: 0,
      score: 0.3,
      triggeredRules: ["insufficient transaction history"],
      contributions: [],
      generatedAt: new Date().toISOString(),
    });
  }

  const candidates = [scoreCybercrime(features), scoreSanctions(features), scoreMixing(features), scoreClean(features)];
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0]!;
  const runnerUp = candidates[1]!;

  const typology = best.score < MIN_CONFIDENT_SCORE ? "unknown" : (best.typology as Exclude<KytTypology, "unknown">);
  const confidence = best.score > 0 ? round2((best.score - runnerUp.score) / best.score) : 0;
  const score = typology === "clean" ? RISK_SCORE.clean
    : typology === "cybercrime_dispersion" ? RISK_SCORE.cybercrime_dispersion
    : typology === "sanctions_evasion" ? RISK_SCORE.sanctions_evasion
    : typology === "mixing" ? RISK_SCORE.mixing
    : 0.3;

  return KytVerdictSchema.parse({
    typology,
    confidence,
    score,
    triggeredRules: best.contributions.map((c) => c.feature),
    contributions: best.contributions,
    generatedAt: new Date().toISOString(),
  });
}
