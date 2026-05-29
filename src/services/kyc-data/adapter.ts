import type { ApiCompanyData, EntityInput } from "../../types/index.js";
import { ComplyAdvantageClient } from "./comply-advantage.js";
import { OpenCorporatesClient } from "./opencorporates.js";

export interface KycDataAdapter { lookup(input: EntityInput): Promise<ApiCompanyData>; }

export class CompositeKycDataAdapter implements KycDataAdapter {
  public constructor(private readonly openCorporates: OpenCorporatesClient, private readonly complyAdvantage: ComplyAdvantageClient) {}

  public async lookup(input: EntityInput): Promise<ApiCompanyData> {
    const [company, screening] = await Promise.all([this.openCorporates.lookup(input), this.complyAdvantage.screen(input)]);
    return {
      ...company,
      sanctions: screening.sanctions,
      pep: screening.pep,
      completeness: company.ubos.length > 0 && company.incorporationDate !== null ? "complete" : "partial"
    };
  }
}
