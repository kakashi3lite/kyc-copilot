import { afterEach, describe, expect, it, vi } from "vitest";
import { KycGraph } from "../../../src/graph/graph.js";
import { DeterministicKycDataAdapter } from "../../../src/services/kyc-data/deterministic.js";
import { CompositeKycDataAdapter } from "../../../src/services/kyc-data/adapter.js";
import { OpenCorporatesClient } from "../../../src/services/kyc-data/opencorporates.js";
import { ComplyAdvantageClient } from "../../../src/services/kyc-data/comply-advantage.js";
import type { AgentState } from "../../../src/graph/state.js";

/**
 * Keyless (zero-key) integration coverage — the exact code path the demo
 * relies on: `CompositeKycDataAdapter` falls back to
 * `DeterministicKycDataAdapter` when external providers are unreachable or
 * unkeyed, so every case still reaches a verdict (completed or pending_hitl).
 *
 * No network calls are made: the graph is built with the deterministic
 * adapter directly (the fallback target) and with a T0-style deterministic
 * LLM, mirroring `LLM_TIER_PRIMARY=t0` + zero-key operation.
 */
function keylessGraph() {
  return new KycGraph({
    adapter: new DeterministicKycDataAdapter(),
    browser: {
      lookup: async () => ({ data: null, evidence: null, requiresHuman: true, reason: "browser unavailable in tests" }),
    },
    llm: {
      draftDossier: async (state: AgentState) => {
        const sanctionHit = state.apiData?.sanctions.some((hit) => hit.matched) === true;
        return {
          riskScore: sanctionHit ? "High" : "Low",
          summary: `${state.companyName} was assessed under AMLD6 enhanced due diligence controls. [Source: API_1]`,
          claims: [
            { id: "claim-status", text: `Registry status is ${state.apiData?.status ?? "unknown"}.`, sourceKey: "API_1" },
            { id: "claim-screening", text: sanctionHit ? "Screening returned a sanctions-related match." : "Screening returned no sanctions match.", sourceKey: "API_1" },
          ],
        };
      },
    },
  });
}

describe("keyless KYC flow (deterministic adapter)", () => {
  it("low-risk entity sync-completes with dossier + evidence chain", async () => {
    const state = await keylessGraph().run({ caseId: "case_acme", tenantId: "ten_demo", companyName: "Acme Logistics BV", registrationNumber: "NL12345678", jurisdiction: "NL" });
    expect(state.status).toBe("completed");
    expect(state.requiresHuman).toBe(false);
    expect(state.riskScore).toBe("Low");
    // Dossier cites the API evidence key (INV-001) and the evidence ledger
    // carries the row the report's evidence chain is built from.
    expect(state.dossier).toContain("[Source: API_1]");
    expect(Object.keys(state.evidenceLedger)).toContain("API_1");
    expect(state.apiData?.sourceUrl).toBe("urn:deterministic:kyc-copilot");
  });

  it("high-risk Volkov entity pauses for human review (pending_hitl)", async () => {
    const state = await keylessGraph().run({ caseId: "case_volkov", tenantId: "ten_demo", companyName: "Volkov Capital Partners", registrationNumber: "CY98765432", jurisdiction: "CY" });
    expect(state.status).toBe("pending_hitl");
    expect(state.requiresHuman).toBe(true);
    expect(state.riskScore).toBe("High");
    expect(state.apiData?.sanctions.some((hit) => hit.matched)).toBe(true);
    expect(state.apiData?.pep).toBe(true);
  });

  it("composite adapter fails open to the deterministic adapter when providers are unreachable", async () => {
    // Stub global fetch so both real clients (OpenCorporates, ComplyAdvantage)
    // reject — exactly what happens in zero-key mode (no credentials /
    // unreachable endpoints). The composite must fall back to deterministic
    // instead of throwing.
    const fetchMock = vi.fn(async () => { throw new Error("network unreachable"); });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const composite = new CompositeKycDataAdapter(new OpenCorporatesClient(), new ComplyAdvantageClient());
      const result = await composite.lookup({ companyName: "Acme Logistics BV", registrationNumber: "NL12345678", jurisdiction: "NL" });
      expect(result.completeness).toBe("complete");
      expect(result.sourceUrl).toBe("urn:deterministic:kyc-copilot");
      expect(result.sanctions).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
