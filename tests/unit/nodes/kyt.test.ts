import { describe, expect, it } from "vitest";
import { kytNode } from "../../../src/graph/nodes/kyt.js";
import { guardrailNode } from "../../../src/graph/nodes/guardrail.js";
import { initialState, mergeState } from "../../../src/graph/state.js";
import { stripPiiFromGraphState } from "../../../src/workers/graph-runner.js";
import { KYT_ESCALATION_MIN_CONFIDENCE } from "../../../src/services/kyt/typology.js";
import { generateWalletTransactions } from "../../fixtures/transactions-synthetic.js";
import type { ApiCompanyData } from "../../../src/types/index.js";
import type { KytProfileName } from "../../../src/types/kyt.js";

const RISK_PROFILES: Array<{ profile: KytProfileName; seed: number }> = [
  { profile: "cybercrime_dispersion", seed: 1000 },
  { profile: "sanctions_evasion", seed: 2000 },
  { profile: "mixing", seed: 3000 },
];

const baseInput = { caseId: "case_1", tenantId: "ten_1", companyName: "Acme Logistics BV", registrationNumber: "NL12345678", jurisdiction: "NL" };

const cleanApiData: ApiCompanyData = {
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
};

describe("kytNode (Phase 3)", () => {
  it("is a transparent no-op without transaction data", async () => {
    const state = initialState(baseInput);
    const patch = await kytNode(state);
    expect(patch).toEqual({});
  });

  it("classifies wallet data and attaches kyt-typology evidence", async () => {
    const state = initialState(baseInput);
    state.transactionData = generateWalletTransactions("cybercrime_dispersion", 1000);
    const patch = await kytNode(state);

    expect(patch.kytVerdict?.typology).toBe("cybercrime_dispersion");
    expect(patch.kytVerdict?.confidence).toBeGreaterThan(KYT_ESCALATION_MIN_CONFIDENCE);
    const evidence = patch.evidenceLedger?.["kyt-typology"];
    expect(evidence?.kind).toBe("system");
    expect(evidence?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence?.summary).toContain("cybercrime_dispersion");
  });

  it("guardrail escalates every risk typology to HITL", async () => {
    for (const { profile, seed } of RISK_PROFILES) {
      const state = initialState(baseInput);
      state.apiData = cleanApiData;
      state.riskScore = "Low";
      state.uboVerified = true;
      state.transactionData = generateWalletTransactions(profile, seed);

      const patched = mergeState(state, await kytNode(state));
      expect(patched.kytVerdict?.typology, `typology ${profile}`).toBe(profile);
      const result = await guardrailNode(patched);

      expect(result.requiresHuman, `escalate ${profile}`).toBe(true);
      expect(result.status).toBe("pending_hitl");
      expect(result.guardrailFindings?.some((f) => f.includes("KYT typology"))).toBe(true);
    }
  });

  it("guardrail does NOT escalate a clean typology", async () => {
    const state = initialState(baseInput);
    state.apiData = cleanApiData;
    state.riskScore = "Low";
    state.uboVerified = true;
    state.transactionData = generateWalletTransactions("clean", 4000);

    const patched = mergeState(state, await kytNode(state));
    expect(patched.kytVerdict?.typology).toBe("clean");
    const result = await guardrailNode(patched);
    expect(result.requiresHuman).toBe(false);
    expect(result.status).toBe("completed");
  });

  it("graphState persistence strips raw transactions but keeps the verdict", () => {
    const state = initialState(baseInput);
    state.transactionData = generateWalletTransactions("mixing", 3000);
    state.kytVerdict = {
      typology: "mixing",
      confidence: 0.9,
      score: 0.55,
      triggeredRules: ["timeOfDayEntropy"],
      contributions: [{ feature: "timeOfDayEntropy", weight: 0.35, rationale: "time-of-day obfuscation" }],
      generatedAt: new Date().toISOString(),
    };
    const safe = stripPiiFromGraphState(state as unknown as Record<string, unknown>);
    expect(safe.transactionData).toBeUndefined();
    expect(safe.companyName).toBeUndefined();
    expect(safe.registrationNumber).toBeUndefined();
    expect((safe.kytVerdict as { typology: string }).typology).toBe("mixing");
  });
});
