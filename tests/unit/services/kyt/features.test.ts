import { describe, expect, it } from "vitest";
import {
  counterpartyDiversity,
  extractFeatures,
  peakHourlyVelocity,
  roundNumberRatio,
  timeOfDayEntropy,
  STRUCTURED_SPLIT_THRESHOLD_USD,
} from "../../../../src/services/kyt/features.js";
import type { WalletTransaction } from "../../../../src/types/kyt.js";

describe("KYT feature extraction (deterministic)", () => {
  it("computes hand-verifiable aggregates on a small wallet", () => {
    const txs: WalletTransaction[] = [
      { txId: "t1", timestamp: "2026-06-01T09:00:00Z", valueUsd: 100, direction: "out", counterparty: "cp_001" },
      { txId: "t2", timestamp: "2026-06-01T10:00:00Z", valueUsd: 200, direction: "out", counterparty: "cp_002" },
      { txId: "t3", timestamp: "2026-06-02T09:00:00Z", valueUsd: 300, direction: "in", counterparty: "cp_001" },
    ];
    const f = extractFeatures(txs);

    expect(f.txCount).toBe(3);
    expect(f.totalValueUsd).toBe(600);
    expect(f.meanValueUsd).toBe(200);
    expect(f.maxSingleValueRatio).toBeCloseTo(0.5);
    expect(f.uniqueCounterparties).toBe(2);
    expect(f.counterpartyDiversity).toBeCloseTo(2 / 3);
    expect(f.roundNumberRatio).toBe(1);
    expect(f.dailyFrequency).toBe(3); // span = 1 calendar day
    expect(f.peakHourlyVelocity).toBe(1);
    expect(f.structuredSplitRatio).toBe(0);
    expect(f.inOutBalance).toBeCloseTo(2 / 3); // 1 inbound of 3
    expect(f.averageGapHours).toBeCloseTo(12); // gaps 1h and 23h
    expect(f.timeOfDayEntropy).toBeGreaterThan(0);
    expect(f.timeOfDayEntropy).toBeLessThanOrEqual(1);
  });

  it("roundNumberRatio counts only multiples of 100", () => {
    expect(roundNumberRatio([137.42, 200, 9900])).toBeCloseTo(2 / 3);
    expect(roundNumberRatio([])).toBe(0);
  });

  it("counterpartyDiversity and peakHourlyVelocity are exact", () => {
    const txs: WalletTransaction[] = [
      { txId: "a", timestamp: "2026-06-01T09:10:00Z", valueUsd: 1, direction: "in", counterparty: "x" },
      { txId: "b", timestamp: "2026-06-01T09:20:00Z", valueUsd: 1, direction: "in", counterparty: "x" },
      { txId: "c", timestamp: "2026-06-01T09:30:00Z", valueUsd: 1, direction: "in", counterparty: "x" },
      { txId: "d", timestamp: "2026-06-01T14:00:00Z", valueUsd: 1, direction: "in", counterparty: "y" },
    ];
    expect(counterpartyDiversity(txs)).toBeCloseTo(0.5);
    expect(peakHourlyVelocity(txs.map((t) => t.timestamp))).toBe(3);
  });

  it("timeOfDayEntropy is 0 for a single hour and normalized for two", () => {
    const single = ["2026-06-01T09:00:00Z", "2026-06-02T09:00:00Z"];
    expect(timeOfDayEntropy(single)).toBe(0);
    const two = ["2026-06-01T09:00:00Z", "2026-06-01T21:00:00Z"];
    expect(timeOfDayEntropy(two)).toBeCloseTo(1 / Math.log2(24));
  });

  it("structuredSplitRatio flags amounts just under the reporting threshold", () => {
    const txs: WalletTransaction[] = [
      { txId: "a", timestamp: "2026-06-01T09:00:00Z", valueUsd: 9000, direction: "out", counterparty: "x" },
      { txId: "b", timestamp: "2026-06-01T10:00:00Z", valueUsd: 5000, direction: "out", counterparty: "x" },
      { txId: "c", timestamp: "2026-06-01T11:00:00Z", valueUsd: 9800, direction: "out", counterparty: "x" },
    ];
    const f = extractFeatures(txs);
    expect(STRUCTURED_SPLIT_THRESHOLD_USD).toBe(10_000);
    expect(f.structuredSplitRatio).toBeCloseTo(2 / 3);
  });

  it("returns all-zero features for an empty wallet", () => {
    const f = extractFeatures([]);
    expect(f.txCount).toBe(0);
    expect(f.totalValueUsd).toBe(0);
    expect(f.peakHourlyVelocity).toBe(0);
    expect(f.counterpartyDiversity).toBe(0);
    expect(f.inOutBalance).toBe(0);
  });
});
