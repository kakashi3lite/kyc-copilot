import { describe, expect, it } from "vitest";
import { cacheHitRate, entityResolutionF1, evaluateResult, lowCostTierRatio } from "./harness.js";
import type { EvaluationResult, GoldenCase, GoldenDataset } from "./harness.js";

describe("evaluation harness", () => {
  it("computes delta and pass/fail for cost metrics", () => {
    // Cost metrics improve when current < baseline, so the caller passes an
    // explicit negative improvement floor (allow up to a 0.1 regression).
    const r: EvaluationResult = evaluateResult("cost-router", "cost per dossier", 0.08, 0.03, -0.1);
    expect(r.delta).toBeCloseTo(-0.05);
    expect(r.passed).toBe(true);
  });

  it("fails when current does not meet baseline", () => {
    const r = evaluateResult("cost-router", "cache hit rate", 0.15, 0.10);
    expect(r.passed).toBe(false);
  });

  it("low-cost tier ratio (target ≥ 0.60)", () => {
    expect(lowCostTierRatio(["t2", "t4", "t0", "t3", "t2"])).toBeCloseTo(0.6);
    expect(lowCostTierRatio([])).toBe(0);
    expect(lowCostTierRatio(["t4", "t4", "t3"])).toBe(0);
  });

  it("cache hit rate (target ≥ 0.15)", () => {
    expect(cacheHitRate(2, 10)).toBeCloseTo(0.2);
    expect(cacheHitRate(0, 10)).toBe(0);
    expect(cacheHitRate(0, 0)).toBe(0);
  });

  it("entity resolution F1 (target > 0.90)", () => {
    expect(entityResolutionF1(0.95, 0.95)).toBeCloseTo(0.95);
    expect(entityResolutionF1(1, 1)).toBe(1);
  });

  it("golden case type round-trips", () => {
    const golden: GoldenCase = {
      caseId: "g1",
      companyName: "Acme Logistics BV",
      registrationNumber: "NL12345678",
      jurisdiction: "NL",
      expectedRiskScore: "Low",
      expectedTier: "t2",
      expectedEntityResolved: true,
    };
    const dataset: GoldenDataset = { name: "golden-50", cases: [golden] };
    expect(dataset.cases[0]?.expectedTier).toBe("t2");
  });
});
