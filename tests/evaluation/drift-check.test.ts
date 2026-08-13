import { describe, expect, it } from "vitest";
import {
  buildDriftSnapshot,
  detectDrift,
  loadDriftBaseline,
  TierDistributionSchema,
} from "./drift.js";
import type { TierDistribution } from "./drift.js";

const base: TierDistribution = TierDistributionSchema.parse({
  t0: 8,
  t1: 0,
  t2: 8,
  t3: 2,
  t4: 2,
  total: 20,
  agreement: 1,
  lowCostRatio: 0.8,
  entityResolutionF1: 1,
});

describe("drift detection (Phase 5)", () => {
  it("passes when the snapshot matches the baseline", () => {
    const r = detectDrift(base, base);
    expect(r.passed).toBe(true);
    expect(r.alerts).toEqual([]);
  });

  it("alerts when a tier share shifts beyond the threshold", () => {
    const shifted = { ...base, t0: 2, t4: 8 };
    const r = detectDrift(shifted, base);
    expect(r.passed).toBe(false);
    expect(r.alerts.some((a) => a.includes("t0"))).toBe(true);
    expect(r.alerts.some((a) => a.includes("t4"))).toBe(true);
  });

  it("alerts on agreement, low-cost ratio, and entity-F1 regressions", () => {
    expect(detectDrift({ ...base, agreement: 0.5 }, base).alerts.some((a) => a.includes("agreement"))).toBe(true);
    expect(detectDrift({ ...base, lowCostRatio: 0.4 }, base).alerts.some((a) => a.includes("low-cost"))).toBe(true);
    expect(detectDrift({ ...base, entityResolutionF1: 0.8 }, base).alerts.some((a) => a.includes("entity-resolution"))).toBe(true);
  });

  it("the current golden snapshot exactly matches the committed baseline", () => {
    const baseline = loadDriftBaseline();
    expect(baseline).not.toBeNull();
    expect(buildDriftSnapshot()).toEqual(baseline);
    const r = detectDrift(buildDriftSnapshot(), baseline!);
    expect(r.passed, r.alerts.join("; ")).toBe(true);
  });
});
