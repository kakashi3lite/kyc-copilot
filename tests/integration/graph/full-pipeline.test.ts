import { expect, it } from "vitest";
import { KycGraph } from "../../../src/graph/graph.js";
import { completeCompany } from "../../fixtures/mock-api-responses.js";

it("runs ingest to guardrail lifecycle", async () => {
  const graph = new KycGraph({ adapter: { lookup: async () => completeCompany }, browser: { lookup: async () => ({ data: null, evidence: null, requiresHuman: false, reason: "not needed" }) }, llm: { draftDossier: async () => ({ riskScore: "Low", summary: "Summary [Source: API_1]", claims: [{ id: "c1", text: "Active company.", sourceKey: "API_1" }] }) } });
  const state = await graph.run({ caseId: "case_1", tenantId: "ten_1", companyName: "Test BV", registrationNumber: "12345678", jurisdiction: "NL" });
  expect(state.status).toBe("completed");
  expect(state.dossier).toContain("[Source: API_1]");
});
