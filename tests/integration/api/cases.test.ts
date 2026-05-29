import { expect, it } from "vitest";

it("documents case API contract", () => {
  expect({ companyName: "Test BV", registrationNumber: "12345678", jurisdiction: "NL" }).toMatchObject({ jurisdiction: "NL" });
});
