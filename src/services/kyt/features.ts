/**
 * KYT feature extraction — Phase 3.
 *
 * Pure, deterministic functions over a wallet's transaction history. No
 * I/O, no ML, no LLM — the same signals a human analyst would weigh:
 * value distribution, frequency, velocity, counterparty diversity,
 * time-of-day entropy, and structured-splitting near reporting
 * thresholds.
 */

import { KytFeaturesSchema, type KytFeatures, type WalletTransaction } from "../../types/kyt.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** FATF-style structuring threshold (USD) — amounts "just under" this are suspicious. */
export const STRUCTURED_SPLIT_THRESHOLD_USD = 10_000;

export interface FeatureExtractOptions {
  structuredSplitThresholdUsd?: number;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Normalized Shannon entropy (0..1) of the hour-of-day distribution. */
export function timeOfDayEntropy(timestamps: readonly string[]): number {
  const n = timestamps.length;
  if (n === 0) return 0;
  const buckets = new Array<number>(24).fill(0);
  for (const ts of timestamps) buckets[new Date(ts).getUTCHours()]!++;
  let entropy = 0;
  for (const count of buckets) {
    if (count > 0) {
      const p = count / n;
      entropy -= p * Math.log2(p);
    }
  }
  const maxEntropy = Math.log2(24);
  return maxEntropy > 0 ? entropy / maxEntropy : 0;
}

/** Fraction of values that are multiples of 100 (round-number structuring). */
export function roundNumberRatio(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.filter((v) => Math.abs(v % 100) < 1e-6).length / values.length;
}

/** Unique counterparties as a fraction of all txs. */
export function counterpartyDiversity(txs: readonly WalletTransaction[]): number {
  if (txs.length === 0) return 0;
  return new Set(txs.map((t) => t.counterparty)).size / txs.length;
}

/** Max txs in any single 1-hour window. */
export function peakHourlyVelocity(timestamps: readonly string[]): number {
  const buckets = new Map<number, number>();
  for (const ts of timestamps) {
    const hour = Math.floor(Date.parse(ts) / HOUR_MS);
    buckets.set(hour, (buckets.get(hour) ?? 0) + 1);
  }
  return Math.max(0, ...buckets.values());
}

export function extractFeatures(txs: readonly WalletTransaction[], opts: FeatureExtractOptions = {}): KytFeatures {
  const threshold = opts.structuredSplitThresholdUsd ?? STRUCTURED_SPLIT_THRESHOLD_USD;
  const n = txs.length;

  if (n === 0) {
    return KytFeaturesSchema.parse({
      txCount: 0,
      totalValueUsd: 0,
      meanValueUsd: 0,
      stddevValueUsd: 0,
      maxSingleValueRatio: 0,
      roundNumberRatio: 0,
      dailyFrequency: 0,
      peakHourlyVelocity: 0,
      counterpartyDiversity: 0,
      uniqueCounterparties: 0,
      timeOfDayEntropy: 0,
      structuredSplitRatio: 0,
      averageGapHours: 0,
      inOutBalance: 0,
    });
  }

  const values = txs.map((t) => t.valueUsd);
  const total = values.reduce((a, b) => a + b, 0);
  const mean = total / n;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n;
  const maxValue = Math.max(...values);

  const times = txs
    .map((t) => Date.parse(t.timestamp))
    .sort((a, b) => a - b);
  const spanMs = Math.max(1, times[n - 1]! - times[0]!);
  const days = Math.max(1, Math.ceil(spanMs / DAY_MS));

  const structuredCount = values.filter((v) => v >= 0.7 * threshold && v < threshold).length;

  let totalGapHours = 0;
  for (let i = 1; i < n; i++) totalGapHours += (times[i]! - times[i - 1]!) / HOUR_MS;

  const inCount = txs.filter((t) => t.direction === "in").length;
  const inRatio = inCount / n;

  return KytFeaturesSchema.parse({
    txCount: n,
    totalValueUsd: round2(total),
    meanValueUsd: round2(mean),
    stddevValueUsd: round2(Math.sqrt(variance)),
    maxSingleValueRatio: round2(maxValue / total),
    roundNumberRatio: round2(roundNumberRatio(values)),
    dailyFrequency: round2(n / days),
    peakHourlyVelocity: peakHourlyVelocity(txs.map((t) => t.timestamp)),
    counterpartyDiversity: round2(counterpartyDiversity(txs)),
    uniqueCounterparties: new Set(txs.map((t) => t.counterparty)).size,
    timeOfDayEntropy: round2(timeOfDayEntropy(txs.map((t) => t.timestamp))),
    structuredSplitRatio: round2(structuredCount / n),
    averageGapHours: round2(n > 1 ? totalGapHours / (n - 1) : 0),
    inOutBalance: round2(1 - 2 * Math.abs(inRatio - 0.5)),
  });
}
