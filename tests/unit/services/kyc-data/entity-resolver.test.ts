import { describe, expect, it } from "vitest";
import { DeterministicEntityResolver, jaroWinkler } from "../../../../src/services/kyc-data/entity-resolver.js";
import type { ApiCompanyData } from "../../../../src/types/index.js";

function company(overrides: Partial<ApiCompanyData> = {}): ApiCompanyData {
  return {
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
    ...overrides,
  };
}

describe("DeterministicEntityResolver (Sprint 4)", () => {
  it("same name + reg number + jurisdiction → confidence ≥ 0.90, no conflicts", () => {
    const resolved = new DeterministicEntityResolver().resolve(company(), company());
    expect(resolved.confidence).toBeGreaterThanOrEqual(0.9);
    expect(resolved.conflicts).toEqual([]);
    expect(resolved.canonicalName).toBe("Acme Logistics BV");
  });

  it("different names + same reg + different jurisdiction → reg match only (browser 0.44)", () => {
    const resolved = new DeterministicEntityResolver().resolve(
      company({ legalName: "Alpha One", jurisdiction: "NL" }),
      company({ legalName: "Zebra Two", jurisdiction: "DE" }),
    );
    const browser = resolved.sources.find((s) => s.sourceName === "browser");
    // Reg match = 40/90, jurisdiction + name = 0 → browser source confidence ≈ 0.44
    expect(browser?.matchConfidence).toBeCloseTo(0.44, 2);
    // Overall confidence is the mean of the two source confidences.
    expect(resolved.confidence).toBeCloseTo(0.72, 2);
    expect(resolved.conflicts.length).toBeGreaterThan(0);
  });

  it('"Acme Ltd" vs "ACME LIMITED" → name similarity ≥ 0.90', () => {
    expect(jaroWinkler("Acme Ltd", "ACME LIMITED")).toBeGreaterThanOrEqual(0.9);
  });

  it("exact name match → similarity 1.0", () => {
    expect(jaroWinkler("Acme Logistics BV", "acme logistics bv")).toBe(1.0);
  });

  it("no browser data → single source, confidence 1.0", () => {
    const resolved = new DeterministicEntityResolver().resolve(company(), null);
    expect(resolved.sources).toHaveLength(1);
    expect(resolved.sources[0]?.sourceName).toBe("opencorporates");
    expect(resolved.confidence).toBe(1);
  });

  it("browser name conflict below 0.70 → conflict entry created", () => {
    const resolved = new DeterministicEntityResolver().resolve(
      company({ legalName: "Alpha One", registrationNumber: "NL11111111", jurisdiction: "NL" }),
      company({ legalName: "Zebra Two", registrationNumber: "NL99999999", jurisdiction: "DE" }),
    );
    expect(resolved.conflicts).toHaveLength(1);
    expect(resolved.conflicts[0]?.field).toBe("legalName");
    expect(resolved.conflicts[0]?.sourceValues).toMatchObject({
      opencorporates: "Alpha One",
      browser: "Zebra Two",
    });
  });
});
