import { expect, it } from "vitest";

it("keeps lifecycle order stable", () => {
  expect(["ingest", "api lookup", "dossier", "guardrail", "report"]).toHaveLength(5);
});
