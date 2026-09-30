/**
 * registry-check — design-system registry oracle (zero dependencies).
 *
 * Verifies, across the product:
 *   1. Token parity   — tokens.css vs registry tokens (0 missing / 0 undeclared;
 *                       `--exception-*` names are the only allowed omissions).
 *   2. CSS components — registered classes exist in their files, and every
 *                       `ds-*` / `is-*` class in those files is registered.
 *   3. Lit components — files exist and define their registered element name.
 *   4. Usage drift    — every ds-* class and ds-* element used in design-system
 *                       pages and component sources (plus public surfaces) is
 *                       registered. Component sources are scanned token-wise so
 *                       classes inside template expressions (quoted strings in
 *                       lit templates) cannot evade the check.
 *
 * Usage: npm run registry-check        (exit 0 = pass, 1 = drift)
 * First-party replacement for the loop's `npx registry-check` (no such package).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const TOKENS_FILE = join(ROOT, "design-system", "tokens", "tokens.css");
const REGISTRY_FILE = join(ROOT, "design-system", "registry.json");

interface ComponentEntry {
  name: string;
  type: string;
  file: string;
  classes?: string[];
}

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, (block) => {
    const newlines = block.match(/\n/g);
    return newlines ? "\n".repeat(newlines.length) : " ";
  });

const registry = JSON.parse(readFileSync(REGISTRY_FILE, "utf8")) as {
  tokens: Array<{ name: string }>;
  components: ComponentEntry[];
};

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

console.log("registry-check — design-system registry oracle\n");

// ---- 1. Token parity ---------------------------------------------------------

const tokensCss = stripComments(readFileSync(TOKENS_FILE, "utf8"));
const declared = new Set([...tokensCss.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]!));
const registeredTokens = new Set(registry.tokens.map((t) => t.name));
const missingInRegistry = [...declared].filter((n) => !registeredTokens.has(n));
const undeclared = [...registeredTokens].filter((n) => !declared.has(n) && !n.startsWith("--exception"));
check(
  "token parity (tokens.css <-> registry)",
  missingInRegistry.length === 0 && undeclared.length === 0,
  `missing: [${missingInRegistry.join(", ")}] · undeclared: [${undeclared.join(", ")}]`,
);

// ---- 2 + 3. Component files ----------------------------------------------------

const registeredClasses = new Set(registry.components.flatMap((c) => c.classes ?? []));
const litElementNames = new Set(registry.components.filter((c) => c.type.startsWith("lit")).map((c) => c.name));
const isKnownClass = (name: string) =>
  registeredClasses.has(name) || [...registeredClasses].some((c) => c.startsWith(name));

for (const comp of registry.components) {
  const file = join(ROOT, comp.file);
  let source = "";
  try {
    source = readFileSync(file, "utf8");
  } catch {
    check(`component file: ${comp.name}`, false, `${comp.file} missing`);
    continue;
  }

  if (comp.type === "css-class") {
    const classes = comp.classes ?? [];
    const inFile = new Set(
      [...stripComments(source).matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)]
        .map((m) => m[1]!)
        .filter((n) => n.startsWith("ds") || n.startsWith("is")),
    );
    const missing = classes.filter((c) => !inFile.has(c));
    const unregistered = [...inFile].filter((c) => !classes.includes(c));
    check(
      `css classes: ${comp.name}`,
      missing.length === 0 && unregistered.length === 0,
      `missing-in-file: [${missing.join(", ")}] · unregistered-in-registry: [${unregistered.join(", ")}]`,
    );
  } else {
    const defines = new RegExp(`customElements\\.define\\(\\s*["']${comp.name}["']`);
    const ok = defines.test(source);
    check(`lit define: ${comp.name}`, ok, ok ? "" : "customElements.define(name) not found");
  }
}

// ---- 4. Usage drift -------------------------------------------------------------

const usageTargets: Array<{ path: string; mode: "attr" | "token" }> = [];
const pushIfFile = (path: string) => {
  try {
    if (statSync(path).isFile()) usageTargets.push({ path, mode: "attr" });
  } catch {
    /* ignore */
  }
};

for (const page of ["layouts.html", "components.html"]) {
  pushIfFile(join(ROOT, "design-system", page));
}
try {
  for (const entry of readdirSync(join(ROOT, "design-system", "components"))) {
    if (entry.endsWith(".js") && !entry.startsWith("._")) {
      usageTargets.push({ path: join(ROOT, "design-system", "components", entry), mode: "token" });
    }
  }
} catch {
  /* ignore */
}
try {
  for (const entry of readdirSync(join(ROOT, "public"))) {
    if (entry.endsWith(".html") && !entry.startsWith("._")) {
      usageTargets.push({ path: join(ROOT, "public", entry), mode: "attr" });
    }
  }
} catch {
  /* ignore */
}

let unknownUsages = 0;
for (const target of usageTargets) {
  const source = readFileSync(target.path, "utf8");
  const rel = target.path.slice(ROOT.length + 1);

  if (target.mode === "attr") {
    for (const match of source.matchAll(/class="([^"]*)"/g)) {
      for (const token of match[1]!.split(/\s+/)) {
        const clean = token.replace(/\$\{.*$/, ""); // drop template expressions
        if (!clean.startsWith("ds-")) continue;
        if (!isKnownClass(clean)) {
          unknownUsages += 1;
          console.log(`  DRIFT ${rel}: class "${clean}"`);
        }
      }
    }
  } else {
    // Token-wise scan so quoted classes inside template expressions are checked too.
    for (const match of source.matchAll(/ds-[a-z0-9_-]+/g)) {
      const token = match[0]!.replace(/-+$/, ""); // trim template-boundary hyphens (e.g. ds-btn--)
      if (registeredClasses.has(token) || litElementNames.has(token)) continue;
      if ([...registeredClasses].some((c) => c.startsWith(token))) continue; // template prefix (ds-badge--)
      unknownUsages += 1;
      console.log(`  DRIFT ${rel}: token "${token}"`);
    }
  }

  for (const match of source.matchAll(/<(ds-[a-z0-9-]+)/g)) {
    if (!litElementNames.has(match[1]!)) {
      unknownUsages += 1;
      console.log(`  DRIFT ${rel}: element <${match[1]}>`);
    }
  }
}
check("usage drift (ds-* classes + ds-* elements)", unknownUsages === 0, `${unknownUsages} unknown usage(s)`);

console.log(`\nRESULT: ${failures === 0 ? "PASS" : "FAIL"} — ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
