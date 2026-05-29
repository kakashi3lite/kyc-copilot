const htmlTagPattern = /<[^>]*>/g;
const injectionPattern = /[<>{}]|javascript:|on\w+=/gi;

export function sanitizeInput(value: string): string {
  return value.normalize("NFKC").replace(htmlTagPattern, "").replace(injectionPattern, "").trim();
}

export function maskName(value: string): string {
  const clean = sanitizeInput(value);
  return clean.split(/\s+/).map((part) => {
    if (part.length <= 2) return "**";
    return `${part.slice(0, 2)}${"*".repeat(Math.min(6, Math.max(2, part.length - 2)))}`;
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
