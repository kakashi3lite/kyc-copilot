import type { ApiCompanyData, EntityInput } from "../../types/index.js";
import { CircuitBreaker, withRetry } from "../../utils/retry.js";
import { sanitizeInput } from "../../utils/mask.js";

interface OpenCorporatesResponse { name?: string; company_number?: string; jurisdiction_code?: string; current_status?: string; incorporation_date?: string; registered_address_in_full?: string; }

export class OpenCorporatesClient {
  private readonly breaker = new CircuitBreaker(5, 30000);
  public constructor(private readonly baseUrl = "https://api.opencorporates.com/v0.4") {}

  public async lookup(input: EntityInput): Promise<ApiCompanyData> {
    return await this.breaker.execute(async () => withRetry(async () => {
      const jurisdiction = sanitizeInput(input.jurisdiction).toLowerCase();
      const registration = encodeURIComponent(sanitizeInput(input.registrationNumber));
      const url = `${this.baseUrl}/companies/${jurisdiction}/${registration}`;
      const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`OpenCorporates ${response.status}`);
      const json = await response.json() as { results?: { company?: OpenCorporatesResponse } };
      const company = json.results?.company;
      if (company === undefined) throw new Error("OpenCorporates empty response");
      return {
        legalName: company.name ?? input.companyName,
        registrationNumber: company.company_number ?? input.registrationNumber,
        jurisdiction: input.jurisdiction,
        status: company.current_status?.toLowerCase().includes("active") ? "active" : "unknown",
        incorporationDate: company.incorporation_date ?? null,
        address: company.registered_address_in_full ?? null,
        ubos: [],
        sanctions: [],
        pep: false,
        sourceUrl: url,
        completeness: "partial"
      };
    }, { attempts: 3, baseDelayMs: 250, maxDelayMs: 2000 }));
  }
}
