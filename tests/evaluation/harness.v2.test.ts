import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DeterministicEntityResolver } from "../../src/services/kyc-data/entity-resolver.js";
import { DeterministicDifficultyClassifier } from "../../src/services/llm/difficulty-classifier.js";
import type { ApiCompanyData } from "../../src/types/index.js";
import type { LlmTier } from "../../src/config/llm-providers.js";
import {
  EntityResolutionGoldenSchema,
  RouterGoldenSchema,
  entityResolutionMetrics,
  routerMetrics,
  simulateCacheHits,
  estimateDossierCost,
  allAtTierCost,
  evaluateCostResult,
  serializeReport,
  type EntityPair,
  type RouterFeatures,
  type EvaluationReport,
} from "./harness.js";

const DATASETS = resolve(process.cwd(), "tests", "evaluation", "datasets");

// ── Real production implementations (no LLM, no I/O) ────────────────────────
const resolver = new DeterministicEntityResolver();
const classifier = new DeterministicDifficultyClassifier();

const resolvePair: (a: EntityPair, b: EntityPair) => number | null = (a, b) => {
  // EntityPair is a structural subset of ApiCompanyData — the cast is safe.
  const resolved = resolver.resolve(a as unknown as ApiCompanyData, b as unknown as ApiCompanyData);
  const browser = resolved.sources.find((s) => s.sourceName === "browser");
  return browser?.matchConfidence ?? null;
};

const classify: (f: RouterFeatures) => LlmTier = (f) => classifier.classify(f).tier;

function loadEntityGolden() {
  const raw = readFileSync(resolve(DATASETS, "entity-resolution-golden.json"), "utf8");
  return EntityResolutionGoldenSchema.parse(JSON.parse(raw));
}

function loadRouterGolden() {
  const raw = readFileSync(resolve(DATASETS, "cost-router-golden.json"), "utf8");
  return RouterGoldenSchema.parse(JSON.parse(raw));
}

describe("golden datasets integrity", () => {
  it("entity-resolution dataset parses, is synthetic (ADR-013), with unique groups", () => {
    const ds = loadEntityGolden();
    expect(ds.synthetic).toBe(true);
    expect(ds.groups).toHaveLength(25);
    const ids = new Set(ds.groups.map((g) => g.groupId));
    expect(ids.size).toBe(ds.groups.length);
    const expectedMerges = ds.groups.filter((g) => g.expectedMerge).length;
    expect(expectedMerges).toBeGreaterThanOrEqual(15);
    for (const g of ds.groups) {
      expect(g.primary.jurisdiction).toHaveLength(2);
      expect(g.secondary.jurisdiction).toHaveLength(2);
    }
  });

  it("cost-router dataset parses with unique caseIds and valid expectations", () => {
    const ds = loadRouterGolden();
    expect(ds.synthetic).toBe(true);
    expect(ds.cases).toHaveLength(20);
    const ids = new Set(ds.cases.map((c) => c.caseId));
    expect(ids.size).toBe(ds.cases.length);
    for (const c of ds.cases) {
      expect(c.jurisdiction).toHaveLength(2);
      expect(["Low", "Medium", "High"]).toContain(c.expectedRiskScore);
      expect(["t0", "t1", "t2", "t3", "t4"]).toContain(c.expectedTier);
      expect(c.features.estimatedTokenCount).toBeGreaterThan(0);
    }
  });
});

describe("golden gates — real implementations, no LLM", () => {
  it("entity resolution F1 > 0.90 with zero false positives/negatives", () => {
    const ds = loadEntityGolden();
    const m = entityResolutionMetrics(ds.groups, resolvePair, ds.resolverThreshold);
    expect(m.f1).toBeGreaterThan(0.9);
    expect(m.falsePositive).toBe(0);
    expect(m.falseNegative).toBe(0);
  });

  it("router tier agreement ≥ 0.85 and low-cost tier ratio ≥ 0.60", () => {
    const ds = loadRouterGolden();
    const m = routerMetrics(ds.cases, classify);
    expect(m.agreement).toBeGreaterThanOrEqual(0.85);
    expect(m.lowCostTierRatio).toBeGreaterThanOrEqual(0.6);
    expect(m.mismatches).toEqual([]);
  });

  it("cache-hit rate ≥ 0.15 on the golden replay workload", () => {
    const ds = loadRouterGolden();
    const cache = simulateCacheHits(ds.cases);
    expect(cache.rate).toBeGreaterThanOrEqual(0.15);
  });

  it("routed cost per dossier is below the all-t4 baseline", () => {
    const ds = loadRouterGolden();
    const m = routerMetrics(ds.cases, classify);
    const perCasePredicted = estimateDossierCost(ds.cases, m.predictedTiers) / ds.cases.length;
    const perCaseWorst = allAtTierCost(ds.cases, "t4") / ds.cases.length;
    const r = evaluateCostResult("cost-router", "cost-per-dossier-usd", perCaseWorst, perCasePredicted);
    expect(r.passed).toBe(true);
    expect(r.delta).toBeLessThan(0);
  });
});

describe("harness v2 primitives", () => {
  it("entityResolutionMetrics computes precision/recall/F1 from a stub resolver", () => {
    const groups = [
      { groupId: "a", expectedMerge: true, primary: p("A"), secondary: p("A") },
      { groupId: "b", expectedMerge: true, primary: p("B"), secondary: p("B") },
      { groupId: "c", expectedMerge: false, primary: p("C"), secondary: p("C2") },
    ];
    const alwaysMerge = () => 0.9;
    const m = entityResolutionMetrics(groups, alwaysMerge, 0.7);
    expect(m.truePositive).toBe(2);
    expect(m.falsePositive).toBe(1);
    expect(m.falseNegative).toBe(0);
    expect(m.precision).toBeCloseTo(2 / 3);
    expect(m.recall).toBe(1);
    expect(m.f1).toBeCloseTo(0.8);
  });

  it("routerMetrics reports mismatches and agreement", () => {
    const cases = [c("r1", "t0"), c("r2", "t2")];
    const m = routerMetrics(cases, () => "t2" as LlmTier);
    expect(m.agreement).toBeCloseTo(0.5);
    expect(m.mismatches).toHaveLength(1);
    expect(m.mismatches[0]?.caseId).toBe("r1");
  });

  it("simulateCacheHits counts only cacheable duplicates", () => {
    const cases = [
      { ...c("x1", "t2"), replayKey: "k", cacheable: true },
      { ...c("x2", "t2"), replayKey: "k", cacheable: true },
      { ...c("x3", "t2"), replayKey: "k", cacheable: false }, // high-risk: cache bypassed
      { ...c("x4", "t2"), replayKey: "other", cacheable: true },
    ];
    const r = simulateCacheHits(cases);
    expect(r.cachedCalls).toBe(1);
    expect(r.rate).toBeCloseTo(0.25);
  });

  it("serializeReport is deterministic for identical reports", () => {
    const report: EvaluationReport = {
      generatedAt: "2026-08-13T00:00:00.000Z",
      synthetic: true,
      results: [
        { subsystem: "cost-router", metric: "tier-agreement", baseline: 0.85, current: 1, delta: 0.15, passed: true },
      ],
    };
    expect(serializeReport(report)).toBe(serializeReport(report));
    expect(JSON.parse(serializeReport(report))).toMatchObject({ synthetic: true, results: [{ passed: true }] });
  });
});

function p(name: string): EntityPair {
  return { sourceName: "opencorporates", legalName: name, registrationNumber: name, jurisdiction: "NL" };
}

function c(caseId: string, expectedTier: LlmTier) {
  return {
    caseId,
    companyName: "X",
    jurisdiction: "NL",
    replayKey: caseId,
    cacheable: true,
    inputTokens: 1000,
    outputTokens: 500,
    expectedRiskScore: "Low" as const,
    expectedTier,
    features: {
      jurisdictionRiskScore: 0,
      hasSanctionsHit: false,
      hasPepFlag: false,
      dataCompleteness: 1,
      uboCount: 1,
      uboVerifiedFraction: 1,
      evidenceSourceCount: 1,
      priorCaseCount: 0,
      estimatedTokenCount: 1000,
    },
  };
}
