/**
 * Shared prompt construction for dossier drafting.
 *
 * All adapters use this to build a consistent prompt from AgentState,
 * ensuring provider-agnostic input formatting.
 */

import type { AgentState } from "../../../graph/state.js";
import { sanitizeInput } from "../../../utils/mask.js";

export function buildDossierPrompt(state: AgentState): string {
  const company = sanitizeInput(state.companyName);
  const jurisdiction = state.jurisdiction;
  const evidenceKeys = Object.keys(state.evidenceLedger);
  const evidenceSummaries = Object.values(state.evidenceLedger)
    .map((e) => `- [${e.key}]: ${e.summary}`)
    .join("\n");

  const sanctionHits = state.apiData?.sanctions
    .filter((s) => s.matched)
    .map((s) => `${s.name} (${s.list})`)
    .join(", ") ?? "none";

  const uboStatus = state.uboVerified
    ? "UBO ownership verified"
    : "UBO ownership NOT verified — requires analyst review";

  const registryStatus = state.apiData?.status ?? "unknown";

  return [
    `Assess the following entity under AMLD6 enhanced due diligence controls.`,
    ``,
    `Company: ${company}`,
    `Jurisdiction: ${jurisdiction}`,
    `Registry status: ${registryStatus}`,
    `UBO status: ${uboStatus}`,
    `Sanctions matches: ${sanctionHits}`,
    `PEP flag: ${state.apiData?.pep ?? false}`,
    ``,
    `Evidence collected (${evidenceKeys.length} sources):`,
    evidenceSummaries || "  (no evidence collected)",
    ``,
    `Instructions:`,
    `1. Produce a "riskScore" of "Low", "Medium", or "High" (never "Pending").`,
    `2. Write a one-paragraph "summary" citing evidence sources using [Source: KEY] format.`,
    `3. Produce "claims" — an array of objects with id, text, and sourceKey.`,
    `4. Each claim must reference an evidence source key from: ${evidenceKeys.join(", ") || "API_1"}.`,
  ].join("\n");
}

/** Rough token estimate for routing decisions (4 chars ≈ 1 token). */
export function estimateTokens(state: AgentState): number {
  const evidenceText = Object.values(state.evidenceLedger)
    .map((e) => e.summary)
    .join(" ");
  const totalChars = (state.companyName?.length ?? 0) +
    (state.dossier?.length ?? 0) +
    evidenceText.length +
    JSON.stringify(state.apiData ?? {}).length;
  return Math.ceil(totalChars / 4);
}
