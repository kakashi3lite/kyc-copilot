/**
 * Synthetic wallet-transaction fixtures for KYT (Phase 3).
 *
 * ADR-013: all fixtures are synthetic — they carry an explicit marker and
 * are NEVER seeded into production data. The generator is deterministic
 * (seeded mulberry32) so golden datasets and benchmarks are reproducible
 * across runs and CI.
 *
 * Profiles mirror the StableAML typology descriptors:
 *   - cybercrime_dispersion: high-velocity fan-out, bursty, many counterparties
 *   - sanctions_evasion:    structured amounts near reporting thresholds,
 *                           few counterparties, steady cadence
 *   - mixing:               obfuscated — uniform day/night activity,
 *                           balanced in/out, round values
 *   - clean:                retail baseline — low frequency, few
 *                           counterparties, natural (non-round) values
 */

import type { KytProfileName, WalletTransaction } from "../../src/types/kyt.js";

export const KYT_SYNTHETIC_MARKER = "synthetic" as const;

export interface KytProfileSpec {
  txCount: number;
  days: number;
  counterparties: number;
  minValue: number;
  maxValue: number;
  /** "hundred" → round to nearest 100; "natural" → 2-decimal values. */
  roundMode: "hundred" | "natural";
  /** Fraction of txs that use the rounding mode. */
  roundBias: number;
  /** >= 0.8 → uniform across 24h; else daytime only (08:00–18:00). */
  entropyBias: number;
  /** cybercrime: cluster txs into peak burst hours. */
  bursty: boolean;
  /** Fraction of inbound txs. */
  inboundRatio: number;
}

export const KYT_PROFILES: Record<KytProfileName, KytProfileSpec> = {
  cybercrime_dispersion: { txCount: 90, days: 7, counterparties: 40, minValue: 10, maxValue: 800, roundMode: "natural", roundBias: 0, entropyBias: 0.3, bursty: true, inboundRatio: 0.9 },
  sanctions_evasion: { txCount: 60, days: 30, counterparties: 3, minValue: 9000, maxValue: 9900, roundMode: "hundred", roundBias: 1, entropyBias: 0.3, bursty: false, inboundRatio: 0.15 },
  mixing: { txCount: 120, days: 14, counterparties: 36, minValue: 500, maxValue: 5000, roundMode: "hundred", roundBias: 0.85, entropyBias: 1, bursty: false, inboundRatio: 0.5 },
  clean: { txCount: 20, days: 90, counterparties: 6, minValue: 50, maxValue: 1500, roundMode: "natural", roundBias: 0, entropyBias: 0.35, bursty: false, inboundRatio: 0.55 },
};

/** Deterministic PRNG (mulberry32) so seeds reproduce identical fixtures. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function buildTx(
  idx: number,
  ts: number,
  spec: KytProfileSpec,
  counterparties: readonly string[],
  rand: () => number,
): WalletTransaction {
  const raw = spec.minValue + rand() * (spec.maxValue - spec.minValue);
  const value = rand() < spec.roundBias
    ? Math.round(raw / 100) * 100
    : Math.round(raw * 100) / 100;
  const direction = rand() < spec.inboundRatio ? "in" : "out";
  const counterparty = counterparties[Math.floor(rand() * counterparties.length)]!;
  return {
    txId: `tx_${String(idx).padStart(4, "0")}`,
    timestamp: new Date(ts).toISOString(),
    valueUsd: value,
    direction,
    counterparty,
  };
}

/** Generate a deterministic wallet transaction set for a profile + seed. */
export function generateWalletTransactions(profile: KytProfileName, seed: number): WalletTransaction[] {
  const spec = KYT_PROFILES[profile];
  const rand = mulberry32(seed);
  const base = Date.parse("2026-06-01T00:00:00Z");
  const dayMs = 86_400_000;
  const counterparties = Array.from({ length: spec.counterparties }, (_, i) => `cp_${String(i + 1).padStart(3, "0")}`);

  // Burst hours for cybercrime: 5 clusters of ~8 txs.
  const bursts: number[] = [];
  if (spec.bursty) {
    for (let b = 0; b < 5; b++) {
      const day = Math.floor(rand() * spec.days);
      const hour = Math.floor(rand() * 24);
      bursts.push(base + day * dayMs + hour * 3_600_000);
    }
  }

  const txs: WalletTransaction[] = [];
  const burstBudget = spec.bursty ? 40 : 0;
  for (let idx = 0; idx < spec.txCount; idx++) {
    let ts: number;
    if (spec.bursty && idx < burstBudget) {
      ts = bursts[idx % bursts.length]! + Math.floor(rand() * 3_600_000);
    } else {
      const day = Math.floor(rand() * spec.days);
      const hour = spec.entropyBias >= 0.8 ? Math.floor(rand() * 24) : 8 + Math.floor(rand() * 11);
      ts = base + day * dayMs + hour * 3_600_000 + Math.floor(rand() * 3_600_000);
    }
    txs.push(buildTx(idx, ts, spec, counterparties, rand));
  }

  return txs.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}
