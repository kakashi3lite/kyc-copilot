import { describe, expect, it, vi } from "vitest";

// graph-runner.ts instantiates a BullMQ Queue at module load and imports the
// db/redis/browser stack — mock all of it so the import is side-effect free.
vi.mock("bullmq", () => {
  const Queue = vi.fn().mockImplementation(function () {
    return { add: vi.fn(), close: vi.fn() };
  });
  const Worker = vi.fn().mockImplementation(function () {
    return { close: vi.fn(), on: vi.fn() };
  });
  return { Queue, Worker };
});

vi.mock("ioredis", () => {
  const Redis = vi.fn().mockImplementation(function () {
    return {
      incr: vi.fn(async () => 1),
      expire: vi.fn(async () => 1),
      ping: vi.fn(async () => "PONG"),
      quit: vi.fn(async () => {}),
      on: vi.fn(),
      defineCommand: vi.fn(),
    };
  });
  return { Redis, default: Redis };
});

vi.mock("pg", () => {
  const queryMock = vi.fn(async () => ({ rows: [] }));
  const clientMock = { query: queryMock, release: vi.fn() };
  const Pool = vi.fn().mockImplementation(function () {
    return { connect: vi.fn(async () => clientMock), query: queryMock, end: vi.fn(async () => {}), on: vi.fn() };
  });
  return { Pool, default: { Pool } };
});

import { stripPiiFromGraphState } from "../../../src/workers/graph-runner.js";

describe("stripPiiFromGraphState (Sprint 1 — ADR-003 PII guard)", () => {
  it("removes decrypted companyName and registrationNumber from the persisted state", () => {
    const state: Record<string, unknown> = {
      caseId: "case_1",
      tenantId: "ten_1",
      companyName: "Acme Logistics BV",
      registrationNumber: "NL12345678",
      jurisdiction: "NL",
      riskScore: "Low",
      dossier: "Dossier text",
      evidenceLedger: { API_1: { key: "API_1" } },
    };
    const safe = stripPiiFromGraphState(state);
    expect(safe).not.toHaveProperty("companyName");
    expect(safe).not.toHaveProperty("registrationNumber");
    expect(safe).toHaveProperty("caseId", "case_1");
    expect(safe).toHaveProperty("jurisdiction", "NL");
    expect(safe).toHaveProperty("riskScore", "Low");
    expect(safe).toHaveProperty("dossier");
    expect(safe).toHaveProperty("evidenceLedger");
  });

  it("does not mutate the in-memory state object", () => {
    const state: Record<string, unknown> = {
      companyName: "Acme Logistics BV",
      registrationNumber: "NL12345678",
      riskScore: "Medium",
    };
    const safe = stripPiiFromGraphState(state);
    expect(state).toHaveProperty("companyName", "Acme Logistics BV");
    expect(state).toHaveProperty("registrationNumber", "NL12345678");
    expect(safe.riskScore).toBe("Medium");
  });
});
