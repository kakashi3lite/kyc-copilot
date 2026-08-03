import { describe, expect, it } from "vitest";
import { apiLookupNode } from "../../../src/graph/nodes/api-lookup.js";
import { initialState } from "../../../src/graph/state.js";
import { completeCompany, companyWithUbos, companyWithoutUbos } from "../../fixtures/mock-api-responses.js";

it("adds API evidence and UBO status", async () => {
  const state = initialState({ caseId: "case_1", tenantId: "ten_1", companyName: "Test BV", registrationNumber: "12345678", jurisdiction: "NL" });
  const patch = await apiLookupNode(state, { adapter: { lookup: async () => completeCompany } });
  expect(patch.uboVerified).toBe(true);
  expect(Object.keys(patch.evidenceLedger ?? {})).toContain("API_1");
});

describe("apiLookupNode evidence summary (ADR-014 D5)", () => {
  function baseState() {
    return initialState({ caseId: "case_1", tenantId: "ten_1", companyName: "Test BV", registrationNumber: "12345678", jurisdiction: "NL" });
  }

  it("sets uboVerified true and includes the UBO count when UBOs are reported", async () => {
    const patch = await apiLookupNode(baseState(), { adapter: { lookup: async () => companyWithUbos } });
    expect(patch.uboVerified).toBe(true);
    expect(patch.evidenceLedger?.API_1?.summary).toContain("2 beneficial owner(s) reported by registry");
  });

  it("sets uboVerified false and omits the UBO count when no UBOs are reported", async () => {
    const patch = await apiLookupNode(baseState(), { adapter: { lookup: async () => companyWithoutUbos } });
    expect(patch.uboVerified).toBe(false);
    expect(patch.evidenceLedger?.API_1?.summary).not.toContain("beneficial owner");
  });
});
