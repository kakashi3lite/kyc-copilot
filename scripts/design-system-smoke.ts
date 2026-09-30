/**
 * design-system smoke — boots the real Hono app (local Postgres/Redis) and
 * drives headless Chromium through every design-system surface + the static
 * product pages. Zero-key demo path; no LLM keys required.
 *
 * Run: npx tsx scripts/design-system-smoke.ts
 */
process.env.NODE_ENV ||= "test";
process.env.DATABASE_URL ||= "postgres://kyc:kyc@localhost:5432/kyc";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.OPENAI_API_KEY ||= "test-openai-key";
process.env.ANTHROPIC_API_KEY ||= "";
process.env.OLLAMA_BASE_URL ||= "http://localhost:11434";
process.env.RESEND_API_KEY ||= "";
process.env.STRIPE_SECRET_KEY ||= "";
process.env.STRIPE_WEBHOOK_SECRET ||= "";
process.env.S3_ENDPOINT ||= "http://localhost:9000";
process.env.S3_ACCESS_KEY ||= "minioadmin";
process.env.S3_SECRET_KEY ||= "minioadmin";
process.env.S3_BUCKET ||= "kyc-evidence";
process.env.ENCRYPTION_KEY ||= "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
process.env.JWT_SECRET ||= "test-access-secret-change-me";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-change-me";
process.env.ALLOWED_ORIGINS ||= "http://localhost:3000";
process.env.PROXY_LIST ||= "";
process.env.RATE_LIMIT_API_PER_MINUTE ||= "100";
process.env.RATE_LIMIT_AUTH_PER_MINUTE ||= "10";
process.env.LOG_LEVEL ||= "error";
process.env.OTEL_ENABLED ||= "false";
process.env.LLM_TIER_PRIMARY ||= "t0";
process.env.LLM_SYNC_ALLOWED_TIERS ||= "t0";

const { createApp } = await import("../src/api/index.js");
const { serve } = await import("@hono/node-server");
const { chromium } = await import("playwright");

const app = createApp();
const server = serve({ fetch: app.fetch, port: 0 });
await new Promise<void>((resolveListening) => server.once("listening", () => resolveListening()));
const address = server.address();
const port = address && typeof address === "object" ? address.port : 0;
const base = `http://127.0.0.1:${port}`;
console.log(`smoke: app booted on ${base}\n`);

let failures = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures += 1;
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const pageErrors: string[] = [];
page.on("pageerror", (err) => pageErrors.push(String(err)));

try {
  // ---- 1. Routes: product pages + design-system assets -----------------------
  const routes: Array<[string, string]> = [
    ["/", "text/html"],
    ["/app", "text/html"],
    ["/login", "text/html"],
    ["/signup", "text/html"],
    ["/forgot-password.html", "text/html"],
    ["/reset-password.html", "text/html"],
    ["/design-system/tokens.css", "text/css"],
    ["/design-system/css/layouts.css", "text/css"],
    ["/design-system/state/store.js", "javascript"],
    ["/design-system/components/ds-data-table.js", "javascript"],
    ["/vendor/lit/index.js", "javascript"],
    ["/design-system/layouts.html", "text/html"],
    ["/design-system/components.html", "text/html"],
    ["/case/case_demo_hitl_0002", "text/html"],
    ["/case/case_demo_hitl_0002/dossier", "text/html"],
  ];
  for (const [path, type] of routes) {
    const res = await page.request.get(base + path);
    const ok = res.ok() && (res.headers()["content-type"] ?? "").includes(type);
    check(`GET ${path}`, ok, `${res.status()} ${res.headers()["content-type"]}`);
  }

  const evil = await page.request.get(base + "/vendor/lit/..%2f..%2fpackage.json");
  check("vendor traversal blocked", evil.status() === 404, `status ${evil.status()}`);

  // ---- 2. layouts.html: routing + theme persistence ---------------------------
  await page.goto(base + "/design-system/layouts.html");
  check(
    "layouts: default hash → dashboard view",
    await page.evaluate(() => !document.getElementById("view-dashboard").hidden),
  );

  await page.click('a[href="#/case/ACME-001"]');
  await page.waitForFunction(() => document.getElementById("param-label")?.textContent === "ACME-001");
  check(
    "layouts: #/case/:id → case detail + :id param",
    await page.evaluate(() => !document.getElementById("view-case-detail").hidden),
  );

  await page.goBack();
  await page.waitForFunction(() => !document.getElementById("view-dashboard").hidden);
  check("layouts: browser back button → dashboard", true);

  const themeBefore = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  await page.click("#theme-toggle");
  const themeAfter = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  await page.reload();
  const themeReload = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  check(
    "layouts: theme toggle persists across reload",
    themeBefore !== themeAfter && themeReload === themeAfter,
    `${themeBefore} → ${themeAfter} → reload ${themeReload}`,
  );

  // ---- 3. components.html: all six Lit elements upgrade -----------------------
  await page.goto(base + "/design-system/components.html");
  const tags = [
    "ds-data-table",
    "ds-case-timeline",
    "ds-reason-code-panel",
    "ds-evidence-ledger",
    "ds-dossier-viewer",
    "ds-four-eyes-approval",
  ];
  await page
    .waitForFunction(
      async (names) => {
        await Promise.all(names.map((n) => customElements.whenDefined(n)));
        return names.every((n) => !!document.querySelector(n)?.shadowRoot);
      },
      tags,
      { timeout: 15000 },
    )
    .catch(() => {});
  const upgraded = await page.evaluate((names) => {
    return names.filter((n) => !!document.querySelector(n)?.shadowRoot);
  }, tags);
  check("components: all 6 Lit elements upgraded", upgraded.length === 6, `${upgraded.length}/6 — ${upgraded.join(", ")}`);

  check("browser page errors", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 400));
} finally {
  await browser.close();
  server.close();
}

console.log(`\nRESULT: ${failures === 0 ? "PASS" : "FAIL"} — ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
