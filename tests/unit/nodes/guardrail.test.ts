import { expect, it } from "vitest";
import { guardrailNode } from "../../../src/graph/nodes/guardrail.js";
import { initialState } from "../../../src/graph/state.js";

it("strips uncited claims", async () => {
  const state = initialState({ caseId: "case_1", tenantId: "ten_1", companyName: "Test BV", registrationNumber: "12345678", jurisdiction: "NL" });
  state.dossier = "Valid claim [Source: API_1]\nInvalid claim";
  state.evidenceLedger.API_1 = { key: "API_1", sourceUrl: "https://example.test", summary: "x", kind: "api", capturedAt: new Date().toISOString(), version: 1, hash: "abc" };
  state.uboVerified = true;
  const patch = await guardrailNode(state);
  expect(patch.dossier).toBe("Valid claim [Source: API_1]");
  expect(patch.status).toBe("completed");
});
