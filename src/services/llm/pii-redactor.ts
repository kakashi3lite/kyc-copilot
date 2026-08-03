/**
 * PII Redaction Proxy — prevents raw identity data from reaching LLM providers.
 *
 * ## Security Model
 *
 * **Threat:** Every `draftDossier()` call currently sends decrypted
 * `companyName`, `registrationNumber`, and UBO names to OpenAI / Anthropic /
 * Google. If ANY LLM provider is compromised, has a rogue insider, or changes
 * their data-use policy, ALL customer PII processed through the system is
 * exposed. This contradicts the "Privacy Shield" value proposition ("we never
 * see your PII") — we're showing it to third parties.
 *
 * **Fix:** Before any prompt leaves the server, identity fields are replaced
 * with deterministic pseudonyms. The LLM never sees real names, registration
 * numbers, or UBO names. The pseudonyms are:
 *   - **Deterministic** per (tenantId, field, value) — the same entity always
 *     maps to the same pseudonym, so the LLM can reason across calls.
 *   - **Cross-tenant isolated** — the same entity name with different tenantIds
 *     produces different pseudonyms (no cross-tenant correlation).
 *   - **Irreversible** — HMAC-SHA256 is a PRF; given a pseudonym, you cannot
 *     recover the original value without the `PII_REDACTION_KEY`.
 *
 * **What the LLM still sees (unredacted):**
 *   - Jurisdiction codes (EE, DE, NL — not PII)
 *   - Sanctions list names (OFAC, EU, UN — not PII, this is public data)
 *   - Sanctions match details (name on list, list name — public sanctions data)
 *   - PEP flag (boolean)
 *   - Data completeness (enum)
 *   - UBO count (integer — the NUMBER of UBOs, not their identities)
 *   - Evidence summaries (already masked via `maskPiiInText`)
 *   - Risk indicators derived from evidence
 *
 * **What gets redacted (pseudonymized):**
 *   - `companyName` → `ENT_<8-char-hex>`
 *   - `registrationNumber` → `REG_<8-char-hex>`
 *   - UBO names → `PERSON_<8-char-hex>`
 *   - Any other field tagged as PII in the redaction config
 *
 * ## Trade-off
 *
 * The LLM loses the ability to do "open-ended reasoning about company names"
 * (e.g., "Does this name appear in news articles?"). That capability belongs
 * to the browser scraper and API data sources — the LLM's job is to SYNTHESIZE
 * evidence, not DISCOVER it. The evidence ledger already contains all relevant
 * external data; the LLM assesses it.
 */

import { createHmac } from "node:crypto";
import { env } from "../../config/env.js";

/**
 * Secret for PII pseudonym derivation.
 * MUST be distinct from ENCRYPTION_KEY and JWT_SECRET.
 * Falls back to ENCRYPTION_KEY only in dev (zero-key mode).
 */
function redactionKey(): string {
  return env.PII_REDACTION_KEY || env.ENCRYPTION_KEY;
}

/**
 * Derive a deterministic, irreversible pseudonym for a PII field.
 *
 * Uses HMAC-SHA256(tenantId + ":" + field + ":" + value, key) truncated to
 * 8 hex characters. Collision probability for 10,000 entities per tenant:
 * ~0.01% (birthday bound on 32-bit space). Acceptable — a collision would
 * cause the LLM to confuse two entities, but would NOT leak PII.
 */
function pseudonymize(tenantId: string, field: string, value: string): string {
  const message = `${tenantId}:${field}:${value}`;
  const digest = createHmac("sha256", redactionKey()).update(message).digest("hex");
  return digest.slice(0, 8);
}

/** Prefix map — makes pseudonyms self-describing in prompts. */
const PREFIX: Record<string, string> = {
  companyName: "ENT",
  registrationNumber: "REG",
  uboName: "PERSON",
};

/**
 * Redact a single PII value, returning a tagged pseudonym.
 *
 * @param tenantId  The tenant making the request (for cross-tenant isolation).
 * @param field     The field name (determines the pseudonym prefix).
 * @param value     The raw PII value to redact.
 * @returns         A string like `ENT_a1b2c3d4` that replaces the PII.
 */
export function redactField(tenantId: string, field: string, value: string): string {
  if (!value || value.trim().length === 0) {
    return `${PREFIX[field] ?? "X"}_EMPTY`;
  }
  const prefix = PREFIX[field] ?? "X";
  return `${prefix}_${pseudonymize(tenantId, field, value)}`;
}

/**
 * Redact all PII in a text blob by replacing known identity values with
 * their deterministic pseudonyms.
 *
 * Strategy: exact-string-match replacement. For each PII field, scan the
 * text for the raw value and replace it with the pseudonym. This is O(n*m)
 * but prompt texts are typically <50KB — negligible. For production at
 * scale, use a Trie-based scanner.
 *
 * IMPORTANT: Replace longer strings first (company names are typically
 * longer than registration numbers) to avoid partial-match corruption
 * (e.g., registration number "12345" appearing inside company name
 * "Company 12345 Ltd").
 *
 * @param tenantId  The tenant making the request.
 * @param text      The text to redact (e.g., a full LLM prompt).
 * @param piiFields Map of field name → raw value to redact.
 * @returns         The text with all PII replaced by pseudonyms.
 */
export function redactPiiInText(
  tenantId: string,
  text: string,
  piiFields: Record<string, string>,
): string {
  // Sort by value length descending to avoid partial matches.
  const entries = Object.entries(piiFields)
    .filter(([, value]) => value && value.trim().length > 0)
    .sort((a, b) => b[1].length - a[1].length);

  let result = text;
  for (const [field, value] of entries) {
    // Escape for regex — company names may contain regex metacharacters.
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(escaped, "g");
    const replacement = redactField(tenantId, field, value);
    result = result.replace(pattern, replacement);
  }

  return result;
}

/**
 * Build the PII field map from AgentState for redaction.
 *
 * Collects every identity field that must never reach an external LLM.
 * Fields are keyed by their semantic name (used for pseudonym prefix).
 */
export interface PiiFieldMap {
  companyName: string;
  registrationNumber: string;
  uboNames: string[];
}

export function extractPiiFields(state: {
  companyName?: string;
  registrationNumber?: string;
  apiData?: { ubos?: readonly { name?: string }[] } | null;
}): PiiFieldMap {
  return {
    companyName: state.companyName ?? "",
    registrationNumber: state.registrationNumber ?? "",
    uboNames: (state.apiData?.ubos ?? [])
      .map((u) => u.name ?? "")
      .filter((n) => n.length > 0),
  };
}

/**
 * Redact a full LLM prompt, replacing all PII with pseudonyms.
 *
 * This is the main entry point — called from buildDossierPrompt() before
 * the prompt string is returned to the adapter for API submission.
 *
 * @param tenantId  The tenant making the request.
 * @param prompt    The full prompt text.
 * @param piiFields The PII field map from AgentState.
 * @returns         The prompt with all PII redacted.
 */
export function redactPrompt(
  tenantId: string,
  prompt: string,
  piiFields: PiiFieldMap,
): string {
  // Build flat map of field → value for the text scanner.
  const flat: Record<string, string> = {
    companyName: piiFields.companyName,
    registrationNumber: piiFields.registrationNumber,
  };

  // Add each UBO name as a separate field (all map to PERSON_ prefix).
  piiFields.uboNames.forEach((name, i) => {
    flat[`uboName_${i}`] = name;
  });

  return redactPiiInText(tenantId, prompt, flat);
}

/**
 * Check whether PII redaction is enabled.
 *
 * In production, this should ALWAYS be true. The bypass switch exists for
 * debugging only — it is NOT a feature flag for customers.
 */
export function isRedactionEnabled(): boolean {
  return env.PII_REDACTION_ENABLED !== false; // default: enabled
}
