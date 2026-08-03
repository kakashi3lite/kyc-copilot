import type { ApiCompanyData, EntityInput } from "../../types/index.js";
import { ComplyAdvantageClient } from "./comply-advantage.js";
import { OpenCorporatesClient } from "./opencorporates.js";
import { DeterministicKycDataAdapter } from "./deterministic.js";
import { childLogger } from "../../config/logger.js";

export interface KycDataAdapter { lookup(input: EntityInput): Promise<ApiCompanyData>; }

const log = childLogger({ component: "kyc-data-adapter" });

/**
 * Composite KYC data adapter — real registries/screening first, deterministic
 * fallback on failure (fail-open).
 *
 * Each underlying adapter reports its own `completeness` truthfully; this
 * composite no longer overrides it (see ADR-013). If either the registry
 * lookup or the screening call throws (network error, 401 from a missing
 * ComplyAdvantage key, circuit breaker trip, etc.), the whole composite
 * falls back to {@link DeterministicKycDataAdapter}, which produces a
 * complete, deterministic result so zero-key runs still reach a verdict
 * instead of failing the case.
 */
export class CompositeKycDataAdapter implements KycDataAdapter {
  public constructor(private readonly openCorporates: OpenCorporatesClient, private readonly complyAdvantage: ComplyAdvantageClient) {}

  public async lookup(input: EntityInput): Promise<ApiCompanyData> {
    try {
      const [company, screening] = await Promise.all([this.openCorporates.lookup(input), this.complyAdvantage.screen(input)]);
      return {
        ...company,
        sanctions: screening.sanctions,
        pep: screening.pep
      };
    } catch (error) {
      log.warn({ error: error instanceof Error ? error.message : String(error) }, "external KYC providers failed; falling back to deterministic adapter");
      return new DeterministicKycDataAdapter().lookup(input);
    }
  }
}
