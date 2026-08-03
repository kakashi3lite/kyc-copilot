const htmlTagPattern = /<[^>]*>/g;
const injectionPattern = /[<>{}]|javascript:|on\w+=/gi;

export function sanitizeInput(value: string): string {
  return value.normalize("NFKC").replace(htmlTagPattern, "").replace(injectionPattern, "").trim();
}

export function maskName(value: string): string {
  const clean = sanitizeInput(value);
  return clean.split(/\s+/).map((part) => {
    // Short words are not identifying on their own — reveal them.
    if (part.length <= 4) return part;
    // Keep the first 4 chars of longer words so the dashboard's substring
    // search (Phase C) matches what analysts type ("Acme" → "Acme ..."),
    // while the remainder stays masked. The strong PII control is the
    // encrypted `companyNameEncrypted` column — the mask is display-only.
    return `${part.slice(0, 4)}${"*".repeat(part.length - 4)}`;
  }).join(" ");
}

export function maskRegistration(value: string): string {
  const clean = sanitizeInput(value);
  if (clean.length <= 4) return "****";
  return `${clean.slice(0, 2)}${"*".repeat(Math.max(4, clean.length - 4))}${clean.slice(-2)}`;
}

export function maskPiiInText(input: string): string {
  return input
    .replace(/\b[A-Z][A-Za-z0-9&.-]*(?:\s+[A-Z][A-Za-z0-9&.-]*){1,5}\b/g, (match) => maskName(match))
    .replace(/\b[A-Z]{0,3}\d{5,14}[A-Z]{0,3}\b/g, (match) => maskRegistration(match));
}

export function maskRecord(record: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string") {
      output[key] = /name/i.test(key) ? maskName(value) : /registration/i.test(key) ? maskRegistration(value) : maskPiiInText(value);
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      output[key] = maskRecord(value as Record<string, unknown>);
    } else {
      output[key] = value;
    }
  }
  return output;
}

const SCRIPT_PATTERN = /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi;
const HTML_TAG_PATTERN = /<[^>]*>/g;
const DANGEROUS_PROTOCOL = /javascript:|data:text\/html|vbscript:/gi;

/**
 * Sanitize LLM-generated output text for safe storage and display.
 *
 * Unlike {@link sanitizeInput} (which strips everything aggressive for
 * injection prevention), sanitizeOutput is conservative — it only strips
 * genuinely dangerous constructs while preserving legitimate punctuation
 * and formatting that an LLM might produce in a dossier.
 *
 * Guards against stored XSS: LLM output is persisted in `cases.dossier`
 * (plaintext) and rendered in the dashboard, so a hallucinated
 * `<script>` tag or `javascript:` URL must never survive to the client.
 */
export function sanitizeOutput(text: string): string {
  return text
    .normalize("NFKC")
    .replace(SCRIPT_PATTERN, "")        // strip <script>...</script> blocks
    .replace(DANGEROUS_PROTOCOL, "")    // strip javascript: etc.
    .replace(HTML_TAG_PATTERN, "");     // strip remaining HTML tags
}
