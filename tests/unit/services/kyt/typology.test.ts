import { describe, expect, it } from "vitest";
import { classify } from "../../../../src/services/kyt/typology.js";
import { extractFeatures } from "../../../../src/services/kyt/features.js";
import { KytFeaturesSchema } from "../../../../src/types/kyt.js";
import { generateWalletTransactions } from "../../../fixtures/transactions-synthetic.js";
import type { KytProfileName } from "../../../../src/types/kyt.js";

const PROFILES: KytProfileName[] = ["cybercrime_dispersion", "sanctions_evasion", "mixing", "clean"];

describe("KYT typology classifier (deterministic baseline, ADR-021)", () => {
  it("classifies each synthetic profile to its own typology across seeds", () => {
    for (const profile of PROFILES) {
      for (const seed of [1000, 1001, 1002]) {
        const verdict = classify(extractFeatures(generateWalletTransactions(profile, seed)));
        expect(verdict.typology, `${profile} seed ${seed}`).toBe(profile);
      }
    }
  });

  it("returns 'unknown' for an empty wallet", () => {
    const empty = KytFeaturesSchema.parse({
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
    const verdict = classify(empty);
    expect(verdict.typology).toBe("unknown");
    expect(verdict.confidence).toBe(0);
  });

  it("emits interpretable per-signal contributions for risk typologies", () => {
    const verdict = classify(extractFeatures(generateWalletTransactions("mixing", 3000)));
    expect(verdict.typology).toBe("mixing");
    expect(verdict.contributions.length).toBeGreaterThanOrEqual(3);
    for (const c of verdict.contributions) {
      expect(c.feature.length).toBeGreaterThan(0);
      expect(c.weight).toBeGreaterThan(0);
      expect(c.rationale.length).toBeGreaterThan(0);
    }
  });

  it("maps typologies to a monotonically sensible risk score", () => {
    const scoreFor = (p: KytProfileName): number =>
      classify(extractFeatures(generateWalletTransactions(p, 1000))).score;
    expect(scoreFor("clean")).toBe(0.05);
    expect(scoreFor("sanctions_evasion")).toBe(0.75);
    expect(scoreFor("cybercrime_dispersion")).toBe(0.85);
    expect(scoreFor("mixing")).toBe(0.55);
  });

  it("keeps confidence within [0, 1] and identifies the top signal", () => {
    const verdict = classify(extractFeatures(generateWalletTransactions("sanctions_evasion", 2000)));
    expect(verdict.confidence).toBeGreaterThan(0);
    expect(verdict.confidence).toBeLessThanOrEqual(1);
    expect(verdict.triggeredRules).toContain("structuredSplitRatio");
  });
});
