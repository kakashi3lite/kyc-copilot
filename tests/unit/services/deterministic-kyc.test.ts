import { describe, expect, it } from "vitest";
import { DeterministicKycDataAdapter } from "../../../src/services/kyc-data/deterministic.js";

describe("DeterministicKycDataAdapter", () => {
  it("returns complete data echoing the input identity fields", async () => {
    const adapter = new DeterministicKycDataAdapter();
    const result = await adapter.lookup({ companyName: "Acme Logistics BV", registrationNumber: "NL12345678", jurisdiction: "nl" });
    expect(result.completeness).toBe("complete");
    expect(result.status).toBe("active");
    expect(result.incorporationDate).toBeNull();
    expect(result.address).toBeNull();
    expect(result.ubos).toEqual([]);
    expect(result.sourceUrl).toBe("urn:deterministic:kyc-copilot");
    // Echo fields (jurisdiction normalized to upper case)
    expect(result.legalName).toBe("Acme Logistics BV");
    expect(result.registrationNumber).toBe("NL12345678");
    expect(result.jurisdiction).toBe("NL");
  });

  it("flags the bundled Volkov Capital Partners demo entity as sanctions/PEP", async () => {
    const adapter = new DeterministicKycDataAdapter();
    const result = await adapter.lookup({ companyName: "Volkov Capital Partners", registrationNumber: "CY98765432", jurisdiction: "CY" });
    expect(result.sanctions).toEqual([{ list: "kyc-copilot-demo", matched: true, name: "Volkov Capital Partners" }]);
    expect(result.pep).toBe(true);
    expect(result.completeness).toBe("complete");
  });

  it("matches case-insensitively but is jurisdiction-gated", async () => {
    const adapter = new DeterministicKycDataAdapter();
    // Case-insensitive company name, same jurisdiction → flagged
    const flagged = await adapter.lookup({ companyName: "VOLKOV CAPITAL PARTNERS", registrationNumber: "CY98765432", jurisdiction: "CY" });
    expect(flagged.sanctions.some((hit) => hit.matched)).toBe(true);
    // Same name, different jurisdiction → clean
    const clean = await adapter.lookup({ companyName: "Volkov Capital Partners", registrationNumber: "DE12345678", jurisdiction: "DE" });
    expect(clean.sanctions).toEqual([]);
    expect(clean.pep).toBe(false);
  });

  it("returns a clean result for an unrelated entity", async () => {
    const adapter = new DeterministicKycDataAdapter();
    const result = await adapter.lookup({ companyName: "Startup XYZ", registrationNumber: "DE45678901", jurisdiction: "DE" });
    expect(result.sanctions).toEqual([]);
    expect(result.pep).toBe(false);
    expect(result.ubos).toEqual([]);
    expect(result.completeness).toBe("complete");
  });
});
