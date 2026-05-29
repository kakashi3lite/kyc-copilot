import { describe, expect, it } from "vitest";
import { ingestNode } from "../../../src/graph/nodes/ingest.js";
import { initialState } from "../../../src/graph/state.js";

it("sanitizes and normalizes entity input", async () => {
  const state = initialState({ caseId: "case_1", tenantId: "ten_1", companyName: "<b>Test BV</b>", registrationNumber: "12345678", jurisdiction: "nl" });
  const patch = await ingestNode(state);
  expect(patch.companyName).toBe("Test BV");
  expect(patch.jurisdiction).toBe("NL");
  expect(patch.status).toBe("processing");
});
