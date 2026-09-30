/**
 * token-lint — design-system oracle.
 *
 * Enforces the binding rules from `.design-loop/DESIGN.md` §5 on component CSS
 * and HTML surfaces (inline `<style>` blocks + `style=""` attributes):
 *
 *   1. No raw hex colors, color functions (rgb/rgba/hsl/…/color-mix), or
 *      named color literals.
 *   2. No hardcoded px / rem dimensions (use spacing / radius / type tokens).
 *      Exception: inside `@media` preludes, px values that exactly match a
 *      declared `--bp-*` token (tokens.css) are sanctioned — @media cannot
 *      consume var(), so those literals are the recorded breakpoints.
 *   3. No undeclared tokens — every `var(--token)` must be declared in
 *      `design-system/tokens/tokens.css`.
 *   4. No local custom-property definitions — Layer-3 tokens belong in
 *      tokens.css, not in component files.
 *
 * Usage:
 *   npm run token-lint [-- <dir-or-file>]     (default: design-system/css)
 *   npm run token-lint -- public/landing.html
 *
 * Exit code: 0 = pass, 1 = violations, 2 = bad invocation.
 *
 * First-party replacement for the loop's `npx token-lint` oracle: no such
 * package is used (ADR-006 — no external dependencies for the design system).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = process.cwd();
const TOKENS_FILE = join(ROOT, "design-system", "tokens", "tokens.css");

interface Violation {
  line: number;
  rule: string;
  detail: string;
}

const ALLOWED_KEYWORDS = new Set([
  "transparent",
  "currentcolor",
  "inherit",
  "initial",
  "unset",
  "revert",
  "revert-layer",
]);

/** Named CSS colors that must never appear as literals. */
const NAMED_COLORS = new Set([
  "white", "black", "red", "blue", "green", "orange", "yellow", "purple",
  "pink", "gray", "grey", "silver", "navy", "teal", "olive", "maroon",
  "lime", "aqua", "cyan", "magenta", "fuchsia", "brown", "indigo", "violet",
  "crimson", "coral", "salmon", "tomato", "gold", "khaki", "beige", "ivory",
]);

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/;
const COLOR_FN_RE = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\s*\(/i;
const DIM_RE = /(?<![\w.-])-?\d*\.?\d+(?:px|rem)\b/i;
const VAR_RE = /var\(\s*(--[a-zA-Z0-9-]+)/g;
const DEF_RE = /^\s*(--[a-zA-Z0-9-]+)\s*:/;

function collectCssFiles(target: string): string[] {
  const stat = statSync(target);
  if (stat.isFile()) return /\.(css|html)$/.test(target) ? [target] : [];
  const entries = readdirSync(target, { withFileTypes: true });
  return entries
    .flatMap((entry) => {
      if (entry.name.startsWith("._")) return []; // macOS AppleDouble artifacts
      const full = join(target, entry.name);
      if (entry.isDirectory()) return collectCssFiles(full);
      return entry.isFile() && /\.(css|html)$/.test(entry.name) ? [full] : [];
    })
    .sort();
}

/** Replaces comment blocks with equal-length newline runs (keeps line numbers). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (block) => {
    const newlines = block.match(/\n/g);
    return newlines ? "\n".repeat(newlines.length) : " ";
  });
}

function loadDeclaredTokens(): Set<string> {
  const source = readFileSync(TOKENS_FILE, "utf8");
  const declared = new Set<string>();
  for (const match of source.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) {
    const name = match[1];
    if (name) declared.add(name);
  }
  return declared;
}

/** px values of declared --bp-* tokens — the only literals allowed in @media. */
function loadBreakpoints(): Set<string> {
  const source = readFileSync(TOKENS_FILE, "utf8");
  const values = new Set<string>();
  for (const match of source.matchAll(/(--bp-[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g)) {
    const value = match[2]?.trim();
    if (value) values.add(value);
  }
  return values;
}

function lintLine(line: string, declared: Set<string>, breakpoints: Set<string>): Violation[] {
  const violations: Violation[] = [];

  const hex = HEX_RE.exec(line);
  if (hex) {
    violations.push({
      line: 0,
      rule: "raw-hex",
      detail: `"${hex[0]}" — bind to a semantic token instead of a raw color`,
    });
  }

  const colorFn = COLOR_FN_RE.exec(line.replace(/var\([^)]*\)/g, ""));
  if (colorFn) {
    violations.push({
      line: 0,
      rule: "raw-color-fn",
      detail: `"${colorFn[0]}…" — color math belongs in tokens.css; bind to a token`,
    });
  }

  let dimLine = line;
  if (line.includes("@media")) {
    // @media cannot consume var(): px literals matching declared --bp-* token
    // values are the sanctioned breakpoints; everything else still fails.
    for (const value of breakpoints) dimLine = dimLine.split(value).join("__bp__");
  }
  const dim = DIM_RE.exec(dimLine);
  if (dim) {
    violations.push({
      line: 0,
      rule: "raw-dimension",
      detail: `"${dim[0]}" — use a space/radius/type token (bare 0 is allowed; @media may use declared --bp-* values)`,
    });
  }

  for (const match of line.matchAll(VAR_RE)) {
    const name = match[1];
    if (name && !declared.has(name)) {
      violations.push({
        line: 0,
        rule: "undeclared-token",
        detail: `"${name}" is not declared in tokens.css`,
      });
    }
  }

  const def = DEF_RE.exec(line);
  if (def) {
    violations.push({
      line: 0,
      rule: "local-token-definition",
      detail: `"${def[1]}" — Layer-3 tokens belong in design-system/tokens/tokens.css`,
    });
  }

  // Named color literals — scan the declaration value only (text after the
  // first colon, with var() calls removed to avoid token-name false hits).
  const colon = line.indexOf(":");
  if (colon !== -1) {
    const value = line.slice(colon + 1).replace(/var\([^)]*\)/g, "");
    for (const word of value.match(/[a-zA-Z]+/g) ?? []) {
      const lower = word.toLowerCase();
      if (NAMED_COLORS.has(lower) && !ALLOWED_KEYWORDS.has(lower)) {
        violations.push({
          line: 0,
          rule: "named-color",
          detail: `"${word}" — bind to a semantic token instead of a named color`,
        });
      }
    }
  }

  return violations;
}

interface CssChunk {
  text: string;
  startLine: number;
}

/** Extracts lintable CSS from an HTML document: <style> blocks + style="" attrs. */
function extractHtmlCss(source: string): CssChunk[] {
  const chunks: CssChunk[] = [];

  for (const match of source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    const idx = match.index ?? 0;
    const openEnd = idx + match[0].indexOf(">") + 1;
    const startLine = (source.slice(0, openEnd).match(/\n/g)?.length ?? 0) + 1;
    chunks.push({ text: match[1] ?? "", startLine });
  }

  for (const match of source.matchAll(/style="([^"]*)"|style='([^']*)'/gi)) {
    const idx = match.index ?? 0;
    const startLine = (source.slice(0, idx).match(/\n/g)?.length ?? 0) + 1;
    chunks.push({ text: match[1] ?? match[2] ?? "", startLine });
  }

  return chunks;
}

function main(): number {
  const targetArg = process.argv[2] ?? "design-system/css";
  const target = resolve(ROOT, targetArg);

  let files: string[];
  try {
    files = collectCssFiles(target);
  } catch {
    console.error(`token-lint: target not found: ${targetArg}`);
    return 2;
  }
  if (files.length === 0) {
    console.error(`token-lint: no CSS/HTML files under ${targetArg}`);
    return 2;
  }

  const declared = loadDeclaredTokens();
  const breakpoints = loadBreakpoints();
  let totalViolations = 0;
  let failedFiles = 0;

  console.log("token-lint — design-system oracle");
  console.log(`target: ${targetArg}\n`);

  for (const file of files) {
    const rel = relative(ROOT, file);
    const raw = readFileSync(file, "utf8");
    const fileViolations: Violation[] = [];

    const lintSource = (source: string, offset: number) => {
      stripComments(source).split("\n").forEach((line, index) => {
        for (const violation of lintLine(line, declared, breakpoints)) {
          fileViolations.push({ ...violation, line: offset + index + 1 });
        }
      });
    };

    if (file.endsWith(".html")) {
      for (const chunk of extractHtmlCss(raw)) lintSource(chunk.text, chunk.startLine - 1);
    } else {
      lintSource(raw, 0);
    }

    if (fileViolations.length === 0) {
      console.log(`OK   ${rel}`);
    } else {
      failedFiles += 1;
      totalViolations += fileViolations.length;
      console.log(`FAIL ${rel}`);
      for (const violation of fileViolations) {
        console.log(
          `  L${String(violation.line).padEnd(4)} ${violation.rule.padEnd(23)} ${violation.detail}`,
        );
      }
    }
  }

  console.log("");
  if (totalViolations === 0) {
    console.log(`RESULT: PASS — ${files.length} file(s), 0 violations.`);
    return 0;
  }
  console.log(
    `RESULT: FAIL — ${totalViolations} violation(s) across ${failedFiles} of ${files.length} file(s).`,
  );
  return 1;
}

process.exit(main());
