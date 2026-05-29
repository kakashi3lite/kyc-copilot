import type { ApiCompanyData } from "../../src/types/index.js";

export const completeCompany: ApiCompanyData = {
  legalName: "Test BV",
  registrationNumber: "12345678",
  jurisdiction: "NL",
  status: "active",
  incorporationDate: "2020-01-01",
  address: "Amsterdam",
  ubos: [{ name: "Jane Doe", verified: true, ownershipPct: 75 }],
  sanctions: [],
  pep: false,
  sourceUrl: "https://api.opencorporates.com/v0.4/companies/nl/12345678",
  completeness: "complete"
};
