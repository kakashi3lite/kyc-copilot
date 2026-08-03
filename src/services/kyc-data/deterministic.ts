import type { ApiCompanyData, EntityInput } from "../../types/index.js";
import type { KycDataAdapter } from "./adapter.js";
import { sanitizeInput } from "../../utils/mask.js";

/**
 * Bundled high-risk rule set for zero-key operation.
 *
 * These rules mirror the seeded demo entities (`src/db/seed.ts`) so that a
 * fully keyless run reproduces the intended demo behavior: entities matching
 * a rule are flagged High risk / PEP and routed to human review (HITL),
 * while unrelated entities complete automatically.
 */
const HIGH_RISK_ENTITIES: ReadonlyArray<{ namePattern: RegExp; jurisdiction: string; risk: "High"; pep: boolean; reason: string }> = [
  { namePattern: /volkov/i, jurisdiction: "CY", risk: "High", pep: true, reason: "Nominee-structured entity in elevated-risk jurisdiction" },
];

/**
 * Deterministic KYC data adapter — the T0 tier for registry & screening data.
 *
 * Makes zero network calls and returns a predictable `ApiCompanyData` for any
 * input, echoing the supplied identity fields. It exists so the platform can
 * run an end-to-end demo (and keep functioning) without external API keys:
 *
 * - `completeness` is always `"complete"` so the graph can proceed past the
 *   browser fallback for low-risk entities.
 * - Entities matching a bundled high-risk rule get a sanctions hit and the
 *   `pep` flag, which drives the HITL decision downstream.
 *
 * Matching is case-insensitive and jurisdiction-gated. First-match-wins for
 * risk classification; every matching rule contributes a sanction entry so
 * multi-rule entities surface a complete flag set.
 */
export class DeterministicKycDataAdapter implements KycDataAdapter {
  public async lookup(input: EntityInput): Promise<ApiCompanyData> {
    const name = sanitizeInput(input.companyName).toLowerCase();
    const jurisdiction = sanitizeInput(input.jurisdiction).toUpperCase();

    const matches = HIGH_RISK_ENTITIES.filter(
      (rule) => rule.jurisdiction === jurisdiction && rule.namePattern.test(name),
    );

    return {
      legalName: sanitizeInput(input.companyName),
      registrationNumber: sanitizeInput(input.registrationNumber),
      jurisdiction: input.jurisdiction.toUpperCase(),
      status: "active",
      incorporationDate: null,
      address: null,
      ubos: [],
      sanctions: matches.map((rule) => ({
        list: "kyc-copilot-demo",
        matched: true,
        name: sanitizeInput(input.companyName),
      })),
      pep: matches.some((rule) => rule.pep),
      sourceUrl: "urn:deterministic:kyc-copilot",
      completeness: "complete",
    };
  }
}
