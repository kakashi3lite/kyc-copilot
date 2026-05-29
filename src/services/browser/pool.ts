import { chromium, type Browser } from "playwright";
import type { BrowserResult, EntityInput } from "../../types/index.js";
import { registryUrlFor } from "./registry-map.js";
import { ProxyRotator } from "./proxy-rotator.js";
import { sha256Hex } from "../../utils/id.js";
import { nowIso } from "../../utils/date.js";

const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/605.1.15 Version/17.2 Safari/605.1.15"
] as const;

export interface BrowserFallbackService { lookup(input: EntityInput): Promise<BrowserResult>; }

export class PlaywrightBrowserPool implements BrowserFallbackService {
  private browser: Browser | null = null;
  private active = 0;
  public constructor(private readonly rotator = new ProxyRotator(), private readonly maxContexts = 10) {}

  public async lookup(input: EntityInput): Promise<BrowserResult> {
    if (this.active >= this.maxContexts) return { data: null, evidence: null, requiresHuman: true, reason: "browser pool saturated" };
    this.active += 1;
    try {
      const proxy = this.rotator.next(input.jurisdiction);
      const launchOptions = proxy === null ? { headless: true } : { headless: true, proxy: { server: proxy } };
      this.browser ??= await chromium.launch(launchOptions);
      const userAgent = userAgents[Math.floor(Math.random() * userAgents.length)] ?? userAgents[0];
      const context = await this.browser.newContext({ userAgent });
      const page = await context.newPage();
      const sourceUrl = registryUrlFor(input.jurisdiction);
      await page.goto(sourceUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      const text = (await page.locator("body").innerText({ timeout: 10000 })).slice(0, 4000);
      await context.close();
      if (/captcha|robot|verify you are human/i.test(text)) return { data: null, evidence: null, requiresHuman: true, reason: "captcha detected" };
      const key = "BROWSER_1";
      return {
        data: null,
        evidence: { key, sourceUrl, summary: `Browser registry fallback captured text hash for ${input.jurisdiction}`, kind: "browser", capturedAt: nowIso(), version: 1, hash: sha256Hex(text) },
        requiresHuman: false,
        reason: "registry page captured"
      };
    } catch (error) {
      return { data: null, evidence: null, requiresHuman: true, reason: error instanceof Error ? error.message : String(error) };
    } finally {
      this.active -= 1;
    }
  }

  public async close(): Promise<void> { await this.browser?.close(); this.browser = null; }
}
