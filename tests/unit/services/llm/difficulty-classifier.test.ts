import { describe, expect, it } from "vitest";
import { DeterministicDifficultyClassifier } from "../../../../src/services/llm/difficulty-classifier.js";
import type { DifficultyFeatures } from "../../../../src/services/llm/difficulty-classifier.js";
import { initialState, type AgentState } from "../../../../src/graph/state.js";
import type { ApiCompanyData } from "../../../../src/types/index.js";

const classifier = new DeterministicDifficultyClassifier();

function baseFeatures(overrides: Partial<DifficultyFeatures> = {}): DifficultyFeatures {
  return {
    jurisdictionRiskScore: 0,
    hasSanctionsHit: false,
    hasPepFlag: false,
    dataCompleteness: 1,
    uboCount: 1,
    uboVerifiedFraction: 1,
    evidenceSourceCount: 2,
    priorCaseCount: 0,
    estimatedTokenCount: 1000,
    ...overrides,
  };
}

function apiData(overrides: Partial<ApiCompanyData> = {}): ApiCompanyData {
  return {
    legalName: "Acme Logistics BV",
    registrationNumber: "NL12345678",
    jurisdiction: "NL",
    status: "active",
    incorporationDate: null,
    address: null,
    ubos: [],
    sanctions: [],
    pep: false,
    sourceUrl: "urn:test",
    completeness: "complete",
    ...overrides,
  };
}

describe("DeterministicDifficultyClassifier.classify (tier rules)", () => {
  it("sanctions hit → t4", () => {
    const a = classifier.classify(baseFeatures({ hasSanctionsHit: true }));
    expect(a.tier).toBe("t4");
    expect(a.confidence).toBeGreaterThan(0.9);
  });

  it("PEP flag → t4", () => {
    const a = classifier.classify(baseFeatures({ hasPepFlag: true }));
    expect(a.tier).toBe("t4");
  });

  it("complete data + low risk + all UBOs verified → t0", () => {
    const a = classifier.classify(baseFeatures({
      dataCompleteness: 1,
      jurisdictionRiskScore: 0,
      uboVerifiedFraction: 1,
    }));
    expect(a.tier).toBe("t0");
  });

  it("complete data + low risk + UBOs unverified → t2", () => {
    const a = classifier.classify(baseFeatures({
      dataCompleteness: 1,
      jurisdictionRiskScore: 0,
      uboVerifiedFraction: 0.5,
    }));
    expect(a.tier).toBe("t2");
  });

  it("partial data + greylist jurisdiction → t4", () => {
    const a = classifier.classify(baseFeatures({
      jurisdictionRiskScore: 0.5,
      dataCompleteness: 0.5,
    }));
    expect(a.tier).toBe("t4");
  });

  it("large context (>120K tokens) → t3", () => {
    const a = classifier.classify(baseFeatures({
      estimatedTokenCount: 150_000,
      dataCompleteness: 0.5,
    }));
    expect(a.tier).toBe("t3");
  });

  it("standard case (medium jurisdiction, complete data) → t2", () => {
    const a = classifier.classify(baseFeatures({
      jurisdictionRiskScore: 0.5,
      dataCompleteness: 1.0,
      uboVerifiedFraction: 0,
    }));
    expect(a.tier).toBe("t2");
  });

  it("blacklisted jurisdiction → t4 even with complete data", () => {
    const a = classifier.classify(baseFeatures({
      jurisdictionRiskScore: 1.0,
      dataCompleteness: 1.0,
      uboVerifiedFraction: 1,
    }));
    expect(a.tier).toBe("t4");
  });
});

describe("DeterministicDifficultyClassifier.extractFeatures", () => {
  function makeState(overrides: { jurisdiction?: string; api?: ApiCompanyData } = {}): AgentState {
    const state = initialState({
      caseId: "case_1",
      tenantId: "ten_1",
      companyName: "Acme Logistics BV",
      registrationNumber: "NL12345678",
      jurisdiction: overrides.jurisdiction ?? "NL",
    });
    state.apiData = overrides.api ?? apiData();
    state.evidenceLedger = {
      API_1: { key: "API_1", sourceUrl: "urn:x", summary: "s", kind: "api", capturedAt: new Date().toISOString(), version: 1, hash: "abc" },
      BR_1: { key: "BR_1", sourceUrl: "urn:y", summary: "s2", kind: "browser", capturedAt: new Date().toISOString(), version: 1, hash: "def" },
    };
    return state;
  }

  it("maps blacklist jurisdiction to risk 1.0", () => {
    const f = classifier.extractFeatures(makeState({ jurisdiction: "KP" }));
    expect(f.jurisdictionRiskScore).toBe(1.0);
  });

  it("maps greylist jurisdiction to risk 0.5", () => {
    const f = classifier.extractFeatures(makeState({ jurisdiction: "NG" }));
    expect(f.jurisdictionRiskScore).toBe(0.5);
  });

  it("flags sanctions hits and PEP from apiData", () => {
    const f = classifier.extractFeatures(makeState({
      api: apiData({ sanctions: [{ list: "eu", matched: true, name: "X" }], pep: true }),
    }));
    expect(f.hasSanctionsHit).toBe(true);
    expect(f.hasPepFlag).toBe(true);
  });

  it("computes UBO verification fraction", () => {
    const f = classifier.extractFeatures(makeState({
      api: apiData({ ubos: [
        { name: "A", verified: true, ownershipPct: 50 },
        { name: "B", verified: false, ownershipPct: 50 },
      ] }),
    }));
    expect(f.uboCount).toBe(2);
    expect(f.uboVerifiedFraction).toBe(0.5);
  });

  it("counts evidence sources and completeness", () => {
    const f = classifier.extractFeatures(makeState());
    expect(f.evidenceSourceCount).toBe(2);
    expect(f.dataCompleteness).toBe(1.0);
    const partial = classifier.extractFeatures(makeState({ api: apiData({ completeness: "partial" }) }));
    expect(partial.dataCompleteness).toBe(0.5);
  });
});
