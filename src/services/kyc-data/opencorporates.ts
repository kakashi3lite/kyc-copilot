import type { ApiCompanyData, EntityInput } from "../../types/index.js";
import { CircuitBreaker, withRetry } from "../../utils/retry.js";
import { sanitizeInput } from "../../utils/mask.js";
import { childLogger } from "../../config/logger.js";

const log = childLogger({ component: "opencorporates" });

interface OpenCorporatesResponse { name?: string; company_number?: string; jurisdiction_code?: string; current_status?: string; incorporation_date?: string; registered_address_in_full?: string; }

interface OfficerResponse {
  officer?: {
    name?: string;
    position?: string;
    occupation?: string;
    nationality?: string;
    date_of_birth?: string;
    current_status?: string;
    percentage_of_shares?: unknown;
  };
}

// D2: statuses that disqualify an officer from being a current beneficial
// owner. Officers in these states are dropped, never surfaced as verified.
const RESIGNED_STATUSES = new Set(["resigned", "inactive", "removed"]);

/**
 * Coerce the registry's `percentage_of_shares` (sometimes a number, sometimes
 * a string like "25.0") into a finite 0–100 number. Anything unparseable or
 * absent becomes `null` — ownership is never invented (D3 / ADR-013).
 */
function parseOwnershipPct(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export class OpenCorporatesClient {
  private readonly breaker = new CircuitBreaker(5, 30000);
  // Separate breaker per endpoint (ADR-014): an officers-endpoint outage must
  // not trip the company-lookup breaker and lose available company data.
  private readonly officersBreaker = new CircuitBreaker(5, 30000);
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
      // Real beneficial-ownership extraction (ADR-014). Soft-degrade: if the
      // officers fetch fails or returns no valid officers we proceed with the
      // company-only record and ubos: [] — a documented limitation must not
      // re-introduce every-case HITL (ADR-013).
      const ubos = await this.fetchOfficersSafe(jurisdiction, registration);
      return {
        legalName: company.name ?? input.companyName,
        registrationNumber: company.company_number ?? input.registrationNumber,
        jurisdiction: input.jurisdiction,
        status: company.current_status?.toLowerCase().includes("active") ? "active" : "unknown",
        incorporationDate: company.incorporation_date ?? null,
        address: company.registered_address_in_full ?? null,
        ubos,
        sanctions: [],
        pep: false,
        sourceUrl: url,
        completeness: "complete"
      };
    }, { attempts: 3, baseDelayMs: 250, maxDelayMs: 2000 }));
  }

  /**
   * Fetch beneficial owners from the officers API. First page only (the API
   * returns up to 25 officers per page) — no pagination chasing in v1
   * (ADR-014 D1). Applies the D2 verified/name filter and D3 ownership
   * coercion. Throws on network/HTTP errors; callers decide how to degrade.
   */
  private async fetchOfficers(jurisdiction: string, registration: string): Promise<ApiCompanyData["ubos"]> {
    return await this.officersBreaker.execute(async () => withRetry(async () => {
      const url = `${this.baseUrl}/companies/${jurisdiction}/${registration}/officers`;
      const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`OpenCorporates officers ${response.status}`);
      const json = await response.json() as { results?: { officers?: OfficerResponse[] } };
      const officers = json.results?.officers ?? [];
      return officers
        .map((entry) => entry.officer)
        .filter((officer): officer is NonNullable<typeof officer> => officer !== undefined)
        .filter((officer) => {
          const name = officer.name?.trim() ?? "";
          const status = officer.current_status?.toLowerCase() ?? "";
          return name.length > 0 && !RESIGNED_STATUSES.has(status);
        })
        .map((officer) => ({
          name: officer.name!.trim(),
          verified: true,
          ownershipPct: parseOwnershipPct(officer.percentage_of_shares)
        }));
    }, { attempts: 3, baseDelayMs: 250, maxDelayMs: 2000 }));
  }

  /** Soft-degrade wrapper (D4): officers failure never fails the company lookup. */
  private async fetchOfficersSafe(jurisdiction: string, registration: string): Promise<ApiCompanyData["ubos"]> {
    try {
      const ubos = await this.fetchOfficers(jurisdiction, registration);
      if (ubos.length === 0) {
        log.warn({ jurisdiction, registration }, "no valid officers returned; proceeding without UBOs");
      }
      return ubos;
    } catch (error) {
      log.warn({ error: error instanceof Error ? error.message : String(error) }, "officers fetch failed; proceeding without UBOs");
      return [];
    }
  }
}
