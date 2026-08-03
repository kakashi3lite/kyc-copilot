import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCorporatesClient } from "../../../src/services/kyc-data/opencorporates.js";
import { CompositeKycDataAdapter } from "../../../src/services/kyc-data/adapter.js";
import { ComplyAdvantageClient } from "../../../src/services/kyc-data/comply-advantage.js";

/**
 * UBO extraction coverage for `OpenCorporatesClient` (ADR-014).
 *
 * Verifies the officers-endpoint parsing, the D2 verified/name filter, the
 * D3 ownership coercion (`percentage_of_shares` → `ownershipPct | null`), and
 * the D4 soft-degrade contract: an officers failure must NOT fail the company
 * lookup and must NOT trip the composite adapter into the deterministic
 * fallback (D7).
 */

function companyResponse() {
  return {
    ok: true,
    json: async () => ({
      results: {
        company: {
          name: "Test BV",
          company_number: "12345678",
          jurisdiction_code: "nl",
          current_status: "Active",
          incorporation_date: "2020-01-01",
          registered_address_in_full: "Amsterdam",
        },
      },
    }),
  };
}

function officersResponse() {
  return {
    ok: true,
    json: async () => ({
      results: {
        officers: [
          // valid: numeric percentage
          { officer: { name: "Jane Doe", position: "Director", current_status: "Active", percentage_of_shares: 75 } },
          // valid: string percentage coerced to number
          { officer: { name: "John Smith", position: "Secretary", current_status: "active", percentage_of_shares: "25.0" } },
          // valid: no percentage reported → ownershipPct null (never invented)
          { officer: { name: "No Pct Holder", position: "Director", current_status: "Active" } },
          // dropped: no name
          { officer: { name: "", position: "Unknown", current_status: "active", percentage_of_shares: 10 } },
          // dropped: resigned status
          { officer: { name: "Old Director", position: "Director", current_status: "resigned", percentage_of_shares: 50 } },
          // dropped: inactive status
          { officer: { name: "Former Holder", position: "Owner", current_status: "inactive", percentage_of_shares: 40 } },
        ],
      },
    }),
  };
}

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<{ ok: boolean; json: () => Promise<unknown> }>) {
  const fetchMock = vi.fn(handler);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("OpenCorporatesClient UBO extraction", () => {
  it("parses officers into verified ubos with ownership percentages", async () => {
    stubFetch(async (url: string) => (url.includes("/officers") ? officersResponse() : companyResponse()));
    const client = new OpenCorporatesClient();
    const result = await client.lookup({ companyName: "Test BV", registrationNumber: "12345678", jurisdiction: "NL" });

    expect(result.completeness).toBe("complete");
    expect(result.ubos).toEqual([
      { name: "Jane Doe", verified: true, ownershipPct: 75 },
      { name: "John Smith", verified: true, ownershipPct: 25 },
      { name: "No Pct Holder", verified: true, ownershipPct: null },
    ]);
    expect(result.ubos.length).toBe(3);
  });

  it("drops unnamed and resigned/inactive officers (D2)", async () => {
    stubFetch(async (url: string) => (url.includes("/officers") ? officersResponse() : companyResponse()));
    const client = new OpenCorporatesClient();
    const result = await client.lookup({ companyName: "Test BV", registrationNumber: "12345678", jurisdiction: "NL" });

    const names = result.ubos.map((ubo) => ubo.name);
    expect(names).not.toContain("");
    expect(names).not.toContain("Old Director");
    expect(names).not.toContain("Former Holder");
    // every surviving officer is verified
    expect(result.ubos.every((ubo) => ubo.verified)).toBe(true);
  });

  it("sets ownershipPct when reported and null when absent (D3)", async () => {
    stubFetch(async (url: string) => (url.includes("/officers") ? officersResponse() : companyResponse()));
    const client = new OpenCorporatesClient();
    const result = await client.lookup({ companyName: "Test BV", registrationNumber: "12345678", jurisdiction: "NL" });

    const pct = new Map(result.ubos.map((ubo) => [ubo.name, ubo.ownershipPct]));
    expect(pct.get("Jane Doe")).toBe(75);
    // string "25.0" coerced
    expect(pct.get("John Smith")).toBe(25);
    // absent → null, never invented
    expect(pct.get("No Pct Holder")).toBeNull();
  });

  it("soft-degrades to ubos: [] when the officers fetch throws (D4)", async () => {
    stubFetch(async (url: string) => {
      if (url.includes("/officers")) throw new Error("officers endpoint down");
      return companyResponse();
    });
    const client = new OpenCorporatesClient();
    const result = await client.lookup({ companyName: "Test BV", registrationNumber: "12345678", jurisdiction: "NL" });

    expect(result.ubos).toEqual([]);
    // company-only record still complete — no every-case-HITL
    expect(result.completeness).toBe("complete");
    expect(result.legalName).toBe("Test BV");
  });

  it("soft-degrades to ubos: [] when zero valid officers are returned (D4)", async () => {
    stubFetch(async (url: string) => {
      if (url.includes("/officers")) {
        return { ok: true, json: async () => ({ results: { officers: [] } }) };
      }
      return companyResponse();
    });
    const client = new OpenCorporatesClient();
    const result = await client.lookup({ companyName: "Test BV", registrationNumber: "12345678", jurisdiction: "NL" });

    expect(result.ubos).toEqual([]);
    expect(result.completeness).toBe("complete");
  });

  it("does NOT trip the composite fallback when only the officers endpoint fails (D7)", async () => {
    stubFetch(async (url: string) => {
      if (url.includes("/officers")) throw new Error("officers 500");
      if (url.includes("/searches")) return { ok: true, json: async () => ({ hits: [] }) };
      return companyResponse();
    });

    const composite = new CompositeKycDataAdapter(new OpenCorporatesClient(), new ComplyAdvantageClient());
    const result = await composite.lookup({ companyName: "Test BV", registrationNumber: "12345678", jurisdiction: "NL" });

    expect(result.completeness).toBe("complete");
    expect(result.ubos).toEqual([]);
    // real registry record retained — NOT the deterministic fallback URN
    expect(result.sourceUrl).toContain("api.opencorporates.com");
    expect(result.sourceUrl).not.toBe("urn:deterministic:kyc-copilot");
  });

  it("throws when the company lookup itself fails (composite-level fallback handles it)", async () => {
    stubFetch(async () => {
      throw new Error("network unreachable");
    });
    const client = new OpenCorporatesClient();
    await expect(client.lookup({ companyName: "Test BV", registrationNumber: "12345678", jurisdiction: "NL" })).rejects.toThrow();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
