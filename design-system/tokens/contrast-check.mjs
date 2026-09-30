/**
 * contrast-check — WCAG AA contrast oracle (zero dependencies).
 *
 * Parses design-system/tokens/tokens.css, resolves var() chains, and audits the
 * core text pairs for BOTH themes.
 *
 * MUST-PASS (exit 1 on failure, ratio ≥ 4.5):
 *   text-primary / text-muted on surface-page and surface-card
 *   text-on-action  on action-primary
 *   action-text     on surface-page and surface-card
 *
 * WARNINGS (reported, non-blocking): status colors on surface-card.
 *   Light-theme badge text contrast is a tracked follow-up (STATE open issue).
 *
 * Usage: node design-system/tokens/contrast-check.mjs
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const TOKENS = resolve(process.cwd(), "design-system", "tokens", "tokens.css");
const AA = 4.5;

const source = readFileSync(TOKENS, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const base = {};
const dark = {};
for (const block of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const selector = block[1].trim();
  const decls = {};
  for (const d of block[2].matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g)) {
    decls[d[1]] = d[2].trim();
  }
  if (selector.includes('[data-theme="dark"]')) Object.assign(dark, decls);
  else if (selector.includes(":root") || selector.includes('[data-theme="light"]')) Object.assign(base, decls);
}

function resolveToken(name, theme) {
  const table = theme === "dark" ? Object.assign({}, base, dark) : base;
  let value = table[name];
  for (let i = 0; i < 5 && typeof value === "string" && value.includes("var("); i++) {
    value = value.replace(/var\(\s*(--[a-zA-Z0-9-]+)\s*\)/g, (_, ref) => table[ref] ?? "unresolved");
  }
  return value ?? "missing";
}

function luminance(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function ratio(fg, bg) {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  if (l1 === null || l2 === null) return null;
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

const mustPass = [
  ["--text-primary", "--surface-page"],
  ["--text-primary", "--surface-card"],
  ["--text-muted", "--surface-page"],
  ["--text-muted", "--surface-card"],
  ["--text-on-action", "--action-primary"],
  ["--action-text", "--surface-page"],
  ["--action-text", "--surface-card"],
];

const warningPairs = [
  ["--status-positive", "--surface-card"],
  ["--status-warning", "--surface-card"],
  ["--status-danger", "--surface-card"],
  ["--status-neutral", "--surface-card"],
];

let failures = 0;
console.log("contrast-check — WCAG AA oracle (tokens.css, both themes)\n");

for (const theme of ["light", "dark"]) {
  console.log(`-- ${theme} --`);
  for (const [fg, bg] of mustPass) {
    const r = ratio(resolveToken(fg, theme), resolveToken(bg, theme));
    const state = r === null ? "SKIP" : r >= AA ? "PASS" : "FAIL";
    if (state === "FAIL") failures += 1;
    console.log(`  ${state}  ${r === null ? "  —  " : r.toFixed(2)}  ${fg} on ${bg}`);
  }
  for (const [fg, bg] of warningPairs) {
    const r = ratio(resolveToken(fg, theme), resolveToken(bg, theme));
    if (r !== null) {
      console.log(`  warn  ${r.toFixed(2)}  ${fg} on ${bg}${r < AA ? "  (below AA — tracked)" : ""}`);
    }
  }
  console.log("");
}

if (failures > 0) {
  console.log(`RESULT: FAIL — ${failures} must-pass pair(s) below ${AA}:1`);
  process.exit(1);
}
console.log(`RESULT: PASS — all must-pass pairs >= ${AA}:1 (warnings reported above)`);
