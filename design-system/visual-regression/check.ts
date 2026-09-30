/**
 * design-system visual-regression — boots the real Hono app and captures /
 * compares full-page screenshots of the design-system surfaces.
 *
 * Usage:
 *   npx tsx design-system/visual-regression/check.ts            # compare (creates missing baselines)
 *   npx tsx design-system/visual-regression/check.ts --update   # refresh baselines
 *   npx tsx design-system/visual-regression/check.ts layouts-dashboard components
 *
 * Substitutes the migration prompt's `npx playwright test design-system/visual-regression/<surface>`
 * (playwright test-runner is not a dependency; this uses the installed playwright library).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

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
process.env.LM_TIER_PLACEHOLDER ||= "";
process.env.LLM_TIER_PRIMARY ||= "t0";
process.env.LLM_SYNC_ALLOWED_TIERS ||= "t0";

const { createApp } = await import("../../src/api/index.js");
const { serve } = await import("@hono/node-server");
const { chromium } = await import("playwright");

const HERE = resolve(process.cwd(), "design-system", "visual-regression");
const BASELINES = resolve(HERE, "baselines");
const CURRENT = resolve(HERE, "current");
mkdirSync(BASELINES, { recursive: true });
mkdirSync(CURRENT, { recursive: true });

const args = process.argv.slice(2);
const update = args.includes("--update");
const selected = args.filter((a) => !a.startsWith("--"));

interface Target {
  name: string;
  path: string;
  auth?: boolean;
}

const targets: Target[] = [
  { name: "layouts-dashboard", path: "/design-system/layouts.html" },
  { name: "layouts-case-detail", path: "/design-system/layouts.html#/case/ACME-001" },
  { name: "layouts-dossier", path: "/design-system/layouts.html#/case/ACME-001/dossier" },
  { name: "components", path: "/design-system/components.html" },
  { name: "landing", path: "/" },
  { name: "login", path: "/login" },
  { name: "signup", path: "/signup" },
  { name: "dashboard", path: "/app", auth: true },
  { name: "case-detail", path: "/case/case_demo_hitl_0002", auth: true },
  { name: "dossier", path: "/case/case_demo_hitl_0002/dossier", auth: true },
].filter((t) => selected.length === 0 || selected.includes(t.name));

if (targets.length === 0) {
  console.error(`no targets matched: ${selected.join(", ")}`);
  process.exit(2);
}

const app = createApp();
const server = serve({ fetch: app.fetch, port: 0 });
await new Promise<void>((r) => server.once("listening", () => r()));
const address = server.address();
const port = address && typeof address === "object" ? address.port : 0;
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

const capture = async (target: Target) => {
  await page.goto(base + target.path, { waitUntil: "networkidle" });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.waitForTimeout(400); // settle Lit renders / layout
  const shot = await page.screenshot({ fullPage: true });

  const baselinePath = resolve(BASELINES, `${target.name}.png`);
  if (update || !existsSync(baselinePath)) {
    writeFileSync(baselinePath, shot);
    console.log(`BASE  ${target.name} — baseline ${update && existsSync(baselinePath) ? "updated" : "created"}`);
    return;
  }

  const baseline = readFileSync(baselinePath);
  if (Buffer.compare(baseline, shot) === 0) {
    console.log(`PASS  ${target.name}`);
  } else {
    failures += 1;
    writeFileSync(resolve(CURRENT, `${target.name}.png`), shot);
    console.log(
      `FAIL  ${target.name} — diff vs baseline (baseline ${baseline.length}B, current ${shot.length}B; see current/${target.name}.png)`,
    );
  }
};

// Authenticate once for the dashboard session (JWT in localStorage). Runs
// between the public pass and the authenticated pass: pages with an
// "already logged in" redirect (login) must be captured while logged out.
const authenticate = async () => {
  await page.goto(base + "/", { waitUntil: "networkidle" });
  const loginStatus = await page.evaluate(async () => {
    const res = await fetch("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@example.test", password: "ChangeMe-123456" }),
    });
    if (!res.ok) return res.status;
    const data = await res.json();
    localStorage.setItem("kyc_access_token", data.accessToken);
    localStorage.setItem("kyc_refresh_token", data.refreshToken);
    return 0;
  });
  if (loginStatus !== 0) {
    console.error(`visual-regression: dashboard login failed (HTTP ${loginStatus}) — is the demo DB seeded?`);
    await browser.close();
    server.close();
    process.exit(1);
  }
};

let failures = 0;
console.log(`visual-regression: ${targets.length} target(s)${update ? " [update mode]" : ""}\n`);

try {
  for (const target of targets.filter((t) => !t.auth)) await capture(target);
  if (targets.some((t) => t.auth)) {
    await authenticate();
    for (const target of targets.filter((t) => t.auth)) await capture(target);
  }
} finally {
  await browser.close();
  server.close();
}

console.log(`\nRESULT: ${failures === 0 ? "PASS" : "FAIL"} — ${failures} failed target(s)`);
process.exit(failures === 0 ? 0 : 1);
