import { chromium, type Browser, type BrowserContext } from "playwright";
import type { BrowserResult, EntityInput } from "../../types/index.js";
import { registryUrlFor } from "./registry-map.js";
import { ProxyRotator } from "./proxy-rotator.js";
import { sha256Hex } from "../../utils/id.js";
import { nowIso } from "../../utils/date.js";
import { childLogger } from "../../config/logger.js";

const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/605.1.15 Version/17.2 Safari/605.1.15"
] as const;

/**
 * Thrown when a permit cannot be acquired from a pool semaphore within the
 * configured timeout. Callers (browser-fallback node, pdf renderer) must
 * catch this and degrade gracefully — typically by escalating to HITL
 * (browser-fallback) or returning 503 (pdf renderer).
 */
export class PoolTimeoutError extends Error {
  public constructor(public readonly poolName: string, public readonly timeoutMs: number) {
    super(`Pool "${poolName}" permit timeout after ${timeoutMs}ms`);
    this.name = "PoolTimeoutError";
  }
}

/**
 * Minimal async semaphore: admits at most `capacity` concurrent holders.
 * Excess callers queue FIFO; if a permit is not released within `timeoutMs`
 * the waiter is rejected with `PoolTimeoutError` and removed from the queue.
 *
 * Notes:
 *  - Not reentrant. A holder that calls `acquire()` again on the same
 *    Semaphore will deadlock if `capacity` is exhausted; that is by design
 *    — there is no legitimate reentrant use in this codebase.
 *  - Resolution order is FIFO; under bursty load older callers win, which
 *    is the right behavior for KYC where case ordering matters.
 */
class Semaphore {
  private active = 0;
  private readonly waiters: Array<{ resolve: () => void; reject: (err: Error) => void; timer: NodeJS.Timeout }> = [];
  public constructor(
    private readonly name: string,
    private readonly capacity: number,
    private readonly timeoutMs: number,
  ) {}

  public async acquire(): Promise<void> {
    if (this.active < this.capacity) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new PoolTimeoutError(this.name, this.timeoutMs));
      }, this.timeoutMs);
      // Don't keep the event loop alive solely on this timer; permits are
      // released on completion, but if a request is cancelled the timer
      // should not pin the process.
      timer.unref();
      this.waiters.push({ resolve, reject, timer });
    });
  }

  public release(): void {
    if (this.active > 0) this.active -= 1;
    const next = this.waiters.shift();
    if (next) {
      clearTimeout(next.timer);
      this.active += 1;
      next.resolve();
    }
  }

  public activeCount(): number {
    return this.active;
  }

  public queueLength(): number {
    return this.waiters.length;
  }

  public capacityValue(): number {
    return this.capacity;
  }
}

export interface BrowserFallbackService { lookup(input: EntityInput): Promise<BrowserResult>; }

export interface BrowserPoolHealth {
  browser: { launched: boolean };
  browserFallback: { active: number; capacity: number; queued: number };
  pdfRender: { active: number; capacity: number; queued: number };
}

/**
 * Single long-lived Playwright Chromium instance shared between the
 * browser-fallback graph node and the PDF renderer. Two independent
 * semaphores prevent the two consumers from starving each other:
 *
 *   - browserFallback (capacity 8): graph nodes scraping registries
 *   - pdfRender       (capacity 2): dashboard /report?format=pdf
 *
 * If either pool is saturated, callers wait up to `semaphoreTimeoutMs`
 * (default 30s) for a permit. On timeout, `PoolTimeoutError` is thrown
 * and the caller is expected to degrade gracefully.
 *
 * Memory note: a single Chromium process with up to 10 concurrent contexts
 * is the same envelope the previous hard cap used, but partitioned so a
 * flood of PDF renders can no longer block dossier pipeline.
 */
export class PlaywrightBrowserPool implements BrowserFallbackService {
  private browser: Browser | null = null;
  private readonly browserFallbackSemaphore: Semaphore;
  private readonly pdfRenderSemaphore: Semaphore;
  public constructor(
    private readonly rotator = new ProxyRotator(),
    private readonly maxBrowserFallbackConcurrency = 8,
    private readonly maxPdfRenderConcurrency = 2,
    private readonly semaphoreTimeoutMs = 30_000,
  ) {
    this.browserFallbackSemaphore = new Semaphore("browserFallback", this.maxBrowserFallbackConcurrency, this.semaphoreTimeoutMs);
    this.pdfRenderSemaphore = new Semaphore("pdfRender", this.maxPdfRenderConcurrency, this.semaphoreTimeoutMs);
  }

  public async lookup(input: EntityInput): Promise<BrowserResult> {
    await this.acquireBrowserFallbackPermit();
    try {
      const proxy = this.rotator.next(input.jurisdiction);
      const launchOptions = proxy === null
        ? { headless: true, args: ["--disable-dev-shm-usage", "--no-sandbox"] }
        : { headless: true, proxy: { server: proxy }, args: ["--disable-dev-shm-usage", "--no-sandbox"] };
      this.browser ??= await chromium.launch(launchOptions);
      const userAgent = userAgents[Math.floor(Math.random() * userAgents.length)] ?? userAgents[0];
      const context: BrowserContext = await this.browser.newContext({ userAgent });
      try {
        const page = await context.newPage();
        const sourceUrl = registryUrlFor(input.jurisdiction);
        await page.goto(sourceUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        const text = (await page.locator("body").innerText({ timeout: 10000 })).slice(0, 4000);
        if (/captcha|robot|verify you are human/i.test(text)) {
          return { data: null, evidence: null, requiresHuman: true, reason: "captcha detected" };
        }
        const key = "BROWSER_1";
        return {
          data: null,
          evidence: { key, sourceUrl, summary: `Browser registry fallback captured text hash for ${input.jurisdiction}`, kind: "browser", capturedAt: nowIso(), version: 1, hash: sha256Hex(text) },
          requiresHuman: false,
          reason: "registry page captured"
        };
      } finally {
        await context.close();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { data: null, evidence: null, requiresHuman: true, reason: message };
    } finally {
      this.releaseBrowserFallbackPermit();
    }
  }

  /**
   * Acquire a browser-fallback permit from the dedicated semaphore. Throws
   * `PoolTimeoutError` if a permit cannot be obtained within the configured
   * timeout. The caller MUST eventually call `releaseBrowserFallbackPermit()`.
   *
   * Exposed publicly so test code and advanced graph nodes can exercise the
   * semaphore directly without spinning up Chromium.
   */
  public async acquireBrowserFallbackPermit(): Promise<void> {
    await this.browserFallbackSemaphore.acquire();
  }

  public releaseBrowserFallbackPermit(): void {
    this.browserFallbackSemaphore.release();
  }

  /**
   * Acquire a pdf-render permit and a fresh BrowserContext from the shared
   * Chromium. Caller MUST eventually call `releasePdfRenderPermit(context)`.
   *
   * If permit acquisition times out, `PoolTimeoutError` is thrown and no
   * context is created (no leak).
   * If context creation fails after permit acquisition, the permit is
   * released before re-throwing.
   */
  public async acquirePdfRenderPermit(): Promise<BrowserContext> {
    await this.pdfRenderSemaphore.acquire();
    try {
      this.browser ??= await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage", "--no-sandbox"] });
      const context = await this.browser.newContext();
      return context;
    } catch (error) {
      this.pdfRenderSemaphore.release();
      throw error;
    }
  }

  public releasePdfRenderPermit(context: BrowserContext): void {
    context.close().catch((error: unknown) => {
      childLogger({ component: "browser-pool" }).warn({ error: error instanceof Error ? error.message : String(error) }, "pdf context close failed");
    });
    this.pdfRenderSemaphore.release();
  }

  public health(): BrowserPoolHealth {
    return {
      browser: { launched: this.browser !== null },
      browserFallback: { active: this.browserFallbackSemaphore.activeCount(), capacity: this.browserFallbackSemaphore.capacityValue(), queued: this.browserFallbackSemaphore.queueLength() },
      pdfRender: { active: this.pdfRenderSemaphore.activeCount(), capacity: this.pdfRenderSemaphore.capacityValue(), queued: this.pdfRenderSemaphore.queueLength() }
    };
  }

  public async close(): Promise<void> {
    if (this.browser !== null) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

/**
 * Module-level singleton. There is exactly one Chromium process per Node
 * process; both the graph worker (`createGraph` in `graph-runner.ts`) and
 * the PDF renderer import this getter to share the same instance.
 *
 * If you need a separate pool for tests, construct a fresh
 * `PlaywrightBrowserPool(...)` directly — do not use this getter.
 */
let _instance: PlaywrightBrowserPool | null = null;
export function sharedBrowserPool(): PlaywrightBrowserPool {
  if (_instance === null) _instance = new PlaywrightBrowserPool();
  return _instance;
}
