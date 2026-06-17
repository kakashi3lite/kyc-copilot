import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the 'playwright' module BEFORE importing the pool so the import is
// intercepted. This prevents any real Chromium process from launching during
// the test run, while still letting acquirePdfRenderPermit() exercise the
// chromium.launch → newContext path.
vi.mock("playwright", () => {
  const fakeContext = {
    newPage: vi.fn().mockResolvedValue({ close: vi.fn().mockResolvedValue(undefined) }),
    close: vi.fn().mockResolvedValue(undefined)
  };
  const fakeBrowser = {
    newContext: vi.fn().mockResolvedValue(fakeContext),
    close: vi.fn().mockResolvedValue(undefined)
  };
  return {
    chromium: {
      launch: vi.fn().mockResolvedValue(fakeBrowser)
    }
  };
});

import { PlaywrightBrowserPool, PoolTimeoutError } from "../../../../src/services/browser/pool.js";

/**
 * Fast timeout so saturation tests don't take 30s of real wall time.
 */
const FAST_TIMEOUT_MS = 100;

describe("PlaywrightBrowserPool — Dual-Semaphore", () => {
  let pool: PlaywrightBrowserPool;

  beforeEach(() => {
    pool = new PlaywrightBrowserPool(
      // rotator: use a no-op rotator (default ProxyRotator with empty PROXY_LIST is fine)
      undefined as never,
      8,   // maxBrowserFallbackConcurrency
      2,   // maxPdfRenderConcurrency
      FAST_TIMEOUT_MS,
    );
  });

  afterEach(async () => {
    await pool.close();
  });

  it("acquireBrowserFallbackPermit() respects the concurrency limit of 8", async () => {
    // Hold 8 permits — should succeed without throwing.
    for (let i = 0; i < 8; i += 1) {
      await pool.acquireBrowserFallbackPermit();
    }
    expect(pool.health().browserFallback.active).toBe(8);
    expect(pool.health().browserFallback.queued).toBe(0);
  });

  it("acquireBrowserFallbackPermit() throws PoolTimeoutError when saturated", async () => {
    // Saturate the pool.
    for (let i = 0; i < 8; i += 1) {
      await pool.acquireBrowserFallbackPermit();
    }
    // A 9th waiter must time out within the configured window.
    const start = Date.now();
    await expect(pool.acquireBrowserFallbackPermit()).rejects.toBeInstanceOf(PoolTimeoutError);
    const elapsed = Date.now() - start;
    // Sanity: the timeout was actually honored, not a random failure.
    expect(elapsed).toBeGreaterThanOrEqual(FAST_TIMEOUT_MS - 20);
    expect(elapsed).toBeLessThan(FAST_TIMEOUT_MS + 500);
  });

  it("acquireBrowserFallbackPermit() recovers after release()", async () => {
    // Saturate, then release one, then verify the next waiter is admitted.
    for (let i = 0; i < 8; i += 1) {
      await pool.acquireBrowserFallbackPermit();
    }
    pool.releaseBrowserFallbackPermit();
    expect(pool.health().browserFallback.active).toBe(7);
    // This should resolve immediately (permit is available) — not throw.
    await pool.acquireBrowserFallbackPermit();
    expect(pool.health().browserFallback.active).toBe(8);
  });

  it("acquirePdfRenderPermit() respects the concurrency limit of 2", async () => {
    const ctx1 = await pool.acquirePdfRenderPermit();
    const ctx2 = await pool.acquirePdfRenderPermit();
    expect(ctx1).toBeDefined();
    expect(ctx2).toBeDefined();
    expect(pool.health().pdfRender.active).toBe(2);
    expect(pool.health().pdfRender.queued).toBe(0);
  });

  it("acquirePdfRenderPermit() throws PoolTimeoutError when saturated", async () => {
    await pool.acquirePdfRenderPermit();
    await pool.acquirePdfRenderPermit();
    // A 3rd waiter must time out.
    const start = Date.now();
    await expect(pool.acquirePdfRenderPermit()).rejects.toBeInstanceOf(PoolTimeoutError);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(FAST_TIMEOUT_MS - 20);
    expect(elapsed).toBeLessThan(FAST_TIMEOUT_MS + 500);
  });

  it("two semaphores are independent — saturated fallback pool does not block PDF render", async () => {
    // Saturate the browser-fallback pool completely.
    for (let i = 0; i < 8; i += 1) {
      await pool.acquireBrowserFallbackPermit();
    }
    expect(pool.health().browserFallback.active).toBe(8);

    // PDF render should still be admitted — different semaphore.
    const start = Date.now();
    const ctx = await pool.acquirePdfRenderPermit();
    const elapsed = Date.now() - start;
    expect(ctx).toBeDefined();
    // Resolved essentially immediately, not after the timeout window.
    expect(elapsed).toBeLessThan(FAST_TIMEOUT_MS / 2);
    expect(pool.health().pdfRender.active).toBe(1);
  });

  it("PoolTimeoutError carries pool name and timeout for log forensics", async () => {
    await pool.acquirePdfRenderPermit();
    await pool.acquirePdfRenderPermit();
    try {
      await pool.acquirePdfRenderPermit();
      expect.fail("expected PoolTimeoutError");
    } catch (error) {
      expect(error).toBeInstanceOf(PoolTimeoutError);
      if (error instanceof PoolTimeoutError) {
        expect(error.poolName).toBe("pdfRender");
        expect(error.timeoutMs).toBe(FAST_TIMEOUT_MS);
        expect(error.message).toContain("pdfRender");
        expect(error.message).toContain(String(FAST_TIMEOUT_MS));
      }
    }
  });

  it("health() snapshot reflects both semaphores accurately", async () => {
    await pool.acquireBrowserFallbackPermit();
    await pool.acquireBrowserFallbackPermit();
    await pool.acquirePdfRenderPermit();

    const h = pool.health();
    expect(h.browserFallback).toEqual({ active: 2, capacity: 8, queued: 0 });
    expect(h.pdfRender).toEqual({ active: 1, capacity: 2, queued: 0 });
    expect(h.browser.launched).toBe(true); // chromium.launch was called by acquirePdfRenderPermit
  });
});
