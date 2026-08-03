import { describe, expect, it } from "vitest";
import { guardrailNode } from "../../../src/graph/nodes/guardrail.js";
import { initialState, type AgentState } from "../../../src/graph/state.js";

it("strips uncited claims", async () => {
  const state = initialState({ caseId: "case_1", tenantId: "ten_1", companyName: "Test BV", registrationNumber: "12345678", jurisdiction: "NL" });
  state.dossier = "Valid claim [Source: API_1]\nInvalid claim";
  state.evidenceLedger.API_1 = { key: "API_1", sourceUrl: "https://example.test", summary: "x", kind: "api", capturedAt: new Date().toISOString(), version: 1, hash: "abc" };
  state.uboVerified = true;
  const patch = await guardrailNode(state);
  expect(patch.dossier).toBe("Valid claim [Source: API_1]");
  expect(patch.status).toBe("completed");
});

describe("guardrail HITL decision table (ADR-013)", () => {
  function baseState(): AgentState {
    const state = initialState({ caseId: "case_1", tenantId: "ten_1", companyName: "Test BV", registrationNumber: "12345678", jurisdiction: "NL" });
    state.dossier = "Valid claim [Source: API_1]";
    state.evidenceLedger.API_1 = { key: "API_1", sourceUrl: "https://example.test", summary: "x", kind: "api", capturedAt: new Date().toISOString(), version: 1, hash: "abc" };
    state.uboVerified = false;
    state.browserFailed = false;
    state.apiData = {
      legalName: "Test BV", registrationNumber: "12345678", jurisdiction: "NL", status: "active",
      incorporationDate: null, address: null, ubos: [], sanctions: [], pep: false,
      sourceUrl: "urn:deterministic:kyc-copilot", completeness: "complete"
    };
    return state;
  }

  it("Low + complete + unverified UBO → completed", async () => {
    const state = baseState();
    state.riskScore = "Low";
    const patch = await guardrailNode(state);
    expect(patch.requiresHuman).toBe(false);
    expect(patch.status).toBe("completed");
  });

  it("Medium + unverified UBO → pending_hitl", async () => {
    const state = baseState();
    state.riskScore = "Medium";
    const patch = await guardrailNode(state);
    expect(patch.status).toBe("pending_hitl");
  });

  it("Medium + verified UBO + complete → completed", async () => {
    const state = baseState();
    state.riskScore = "Medium";
    state.uboVerified = true;
    const patch = await guardrailNode(state);
    expect(patch.requiresHuman).toBe(false);
    expect(patch.status).toBe("completed");
  });

  it("High risk → pending_hitl", async () => {
    const state = baseState();
    state.riskScore = "High";
    const patch = await guardrailNode(state);
    expect(patch.status).toBe("pending_hitl");
  });

  it("sanctions match → pending_hitl", async () => {
    const state = baseState();
    state.apiData = { ...state.apiData!, sanctions: [{ list: "kyc-copilot-demo", matched: true, name: "Test BV" }] };
    const patch = await guardrailNode(state);
    expect(patch.status).toBe("pending_hitl");
  });

  it("PEP flag → pending_hitl", async () => {
    const state = baseState();
    state.apiData = { ...state.apiData!, pep: true };
    const patch = await guardrailNode(state);
    expect(patch.status).toBe("pending_hitl");
  });

  it("partial data → pending_hitl", async () => {
    const state = baseState();
    state.apiData = { ...state.apiData!, completeness: "partial" };
    const patch = await guardrailNode(state);
    expect(patch.status).toBe("pending_hitl");
  });

  it("browser failure → pending_hitl", async () => {
    const state = baseState();
    state.browserFailed = true;
    const patch = await guardrailNode(state);
    expect(patch.status).toBe("pending_hitl");
  });
});
