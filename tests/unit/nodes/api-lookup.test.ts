import { describe, expect, it } from "vitest";
import { apiLookupNode } from "../../../src/graph/nodes/api-lookup.js";
import { initialState } from "../../../src/graph/state.js";
import { completeCompany } from "../../fixtures/mock-api-responses.js";

it("adds API evidence and UBO status", async () => {
  const state = initialState({ caseId: "case_1", tenantId: "ten_1", companyName: "Test BV", registrationNumber: "12345678", jurisdiction: "NL" });
  const patch = await apiLookupNode(state, { adapter: { lookup: async () => completeCompany } });
  expect(patch.uboVerified).toBe(true);
  expect(Object.keys(patch.evidenceLedger ?? {})).toContain("API_1");
});
