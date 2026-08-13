import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptPii } from "../../../src/services/encryption/at-rest.js";

const state = vi.hoisted(() => ({
  selectQueue: [] as unknown[],
  setCalls: [] as unknown[],
  queueAdd: vi.fn(async () => {}),
}));

vi.mock("bullmq", () => {
  const Queue = vi.fn().mockImplementation(function () {
    return { add: state.queueAdd, close: vi.fn() };
  });
  return { Queue };
});

// Mock the db module so replay.ts / worker.ts run against scripted rows.
vi.mock("../../../src/db/index.js", () => {
  return {
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => {
            // Lazily-consumed thenable with a chainable `.limit()` (some
            // queries omit limit; a thenable lets `await` resolve to rows).
            let consumed = false;
            const get = () => {
              if (!consumed) {
                consumed = true;
                return state.selectQueue.shift() ?? [];
              }
              return [];
            };
            return {
              limit: vi.fn(async () => get()),
              then: (resolve: (v: unknown) => void): void => { resolve(get()); },
            };
          }),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn((values: unknown) => {
          state.setCalls.push(values);
          return { where: vi.fn(async () => undefined) };
        }),
      })),
    },
    redis: { on: vi.fn(), quit: vi.fn() },
  };
});

import { replayAllForWebhook, replayDelivery } from "../../../src/services/webhooks/replay.js";
import { processPendingWebhooks } from "../../../src/services/webhooks/worker.js";

describe("webhook dead-letter replay (ADR-022)", () => {
  beforeEach(() => {
    state.selectQueue = [];
    state.setCalls = [];
    state.queueAdd.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("replays a failed delivery as a status reset and wakes the deliverer", async () => {
    state.selectQueue = [[{ id: "del_1", status: "failed" }]];
    const result = await replayDelivery("del_1", "ten_1");
    expect(result).toBe("replayed");
    expect(state.setCalls[0]).toMatchObject({ status: "pending", attempts: 0, failedAt: null });
    expect(state.queueAdd).toHaveBeenCalledTimes(1);
  });

  it("refuses to replay a delivered delivery", async () => {
    state.selectQueue = [[{ id: "del_1", status: "delivered" }]];
    expect(await replayDelivery("del_1", "ten_1")).toBe("not_failed");
    expect(state.setCalls).toHaveLength(0);
    expect(state.queueAdd).not.toHaveBeenCalled();
  });

  it("reports missing deliveries without side effects", async () => {
    state.selectQueue = [[]];
    expect(await replayDelivery("nope", "ten_1")).toBe("missing");
    expect(state.setCalls).toHaveLength(0);
    expect(state.queueAdd).not.toHaveBeenCalled();
  });

  it("replays all failed deliveries for a webhook and skips the rest", async () => {
    state.selectQueue = [
      [{ id: "wh_1" }], // owner check
      [
        { id: "d1", status: "failed" },
        { id: "d2", status: "failed" },
        { id: "d3", status: "delivered" },
      ],
    ];
    const result = await replayAllForWebhook("wh_1", "ten_1");
    expect(result).toEqual({ replayed: 2, skipped: 1 });
    expect(state.setCalls).toHaveLength(1);
    expect(state.queueAdd).toHaveBeenCalledTimes(1);
  });

  it("returns null for a missing or foreign webhook", async () => {
    state.selectQueue = [[]];
    expect(await replayAllForWebhook("wh_1", "ten_1")).toBeNull();
    expect(state.queueAdd).not.toHaveBeenCalled();
  });

  it("worker dead-letters a delivery after MAX_ATTEMPTS and stamps failedAt", async () => {
    const now = Date.now();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 })));
    const deliveryRow = {
      id: "del_1",
      webhookId: "wh_1",
      tenantId: "ten_1",
      event: "case.completed",
      payload: { caseId: "case_1" },
      attempts: 2,
      status: "pending",
      nextAttemptAt: new Date(now - 1000),
      lastError: null,
      createdAt: new Date(now - 5000),
      updatedAt: new Date(now - 5000),
      deletedAt: null,
    };
    const webhookRow = {
      id: "wh_1",
      tenantId: "ten_1",
      urlEncrypted: encryptPii("http://127.0.0.1:9/wh"),
      urlMask: "http://127.0.0.1:9",
      secretEncrypted: encryptPii("whsec_test"),
      events: ["case.completed"],
      active: true,
      createdAt: new Date(now - 5000),
      updatedAt: new Date(now - 5000),
    };
    state.selectQueue = [[deliveryRow], [deliveryRow], [webhookRow]];
    await processPendingWebhooks();
    // The worker's dead-letter update is the final set() call.
    const workerUpdate = state.setCalls[state.setCalls.length - 1] as Record<string, unknown>;
    expect(workerUpdate.status).toBe("failed");
    expect(workerUpdate.failedAt).toBeInstanceOf(Date);
  });
});
