import { describe, expect, it, vi } from "vitest";
import { draftDossierNode } from "../../../src/graph/nodes/draft-dossier.js";
import { buildGraphEnhancedPrompt } from "../../../src/services/llm/adapters/prompt.js";
import type { GraphQueryService, GraphContext } from "../../../src/services/kyc-data/graph-query.js";
import type { LlmClient } from "../../../src/services/llm/client.js";
import { initialState, type AgentState } from "../../../src/graph/state.js";
import type { ApiCompanyData } from "../../../src/types/index.js";

// draft-dossier.ts transitively imports graph-query.ts → db/index.ts,
// so ioredis + pg are mocked to keep the import side-effect free.
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

function makeState(): AgentState {
  const state = initialState({
    caseId: "case_1",
    tenantId: "ten_1",
    companyName: "Acme Logistics BV",
    registrationNumber: "NL12345678",
    jurisdiction: "NL",
  });
  state.apiData = {
    legalName: "Acme Logistics BV", registrationNumber: "NL12345678", jurisdiction: "NL", status: "active",
    incorporationDate: null, address: null, ubos: [], sanctions: [], pep: false,
    sourceUrl: "urn:test", completeness: "complete",
  } satisfies ApiCompanyData;
  state.evidenceLedger = {
    API_1: { key: "API_1", sourceUrl: "urn:x", summary: "Registry active", kind: "api", capturedAt: new Date().toISOString(), version: 1, hash: "abc" },
  };
  return state;
}

function fakeLlm(summary = "Clean assessment.", claimText = "Active company."): { client: LlmClient; draftDossier: ReturnType<typeof vi.fn> } {
  const draftDossier = vi.fn(async (): Promise<import("../../../src/services/llm/client.js").DossierDraft> => ({
    riskScore: "Low",
    summary,
    claims: [{ id: "c1", text: claimText, sourceKey: "API_1" }],
  }));
  return { client: { draftDossier }, draftDossier };
}

function graphContext(overrides: Partial<GraphContext> = {}): GraphContext {
  return {
    relatedEntities: [],
    priorCases: [],
    entityResolution: { isNewEntity: true, canonicalName: "Acme Logistics BV", confidence: 1, mergedFrom: 1 },
    ...overrides,
  };
}

function fakeGraphQuery(ctx: GraphContext): {
  service: GraphQueryService;
  upsert: ReturnType<typeof vi.fn>;
  getContext: ReturnType<typeof vi.fn>;
  link: ReturnType<typeof vi.fn>;
} {
  const upsert = vi.fn(async () => "ent_1");
  const getContext = vi.fn(async () => ctx);
  const link = vi.fn(async () => {});
  return {
    service: { upsertEntity: upsert, getContext, linkCaseToEntity: link },
    upsert,
    getContext,
    link,
  };
}

describe("draftDossierNode — output sanitization (Sprint 1)", () => {
  it("strips script blocks from the summary before persisting", async () => {
    const { client, draftDossier } = fakeLlm("<script>alert(1)</script> Clean assessment.");
    const patch = await draftDossierNode(makeState(), { llm: client, graphQuery: fakeGraphQuery(graphContext()).service });
    expect(draftDossier).toHaveBeenCalled();
    expect(patch.dossier).toContain("Clean assessment.");
    expect(patch.dossier).not.toContain("<script>");
    expect(patch.dossier).not.toContain("alert(1)");
  });

  it("sanitizes claim text (event-handler tags removed)", async () => {
    const { client } = fakeLlm("Clean.", "<img onerror=alert(1)>");
    const patch = await draftDossierNode(makeState(), { llm: client, graphQuery: fakeGraphQuery(graphContext()).service });
    expect(patch.claims?.[0]?.text).toBe("");
  });
});

describe("draftDossierNode — graph context (Sprint 5)", () => {
  it("passes the graph context to the LLM and records the graph note in the dossier", async () => {
    const { client, draftDossier } = fakeLlm();
    const ctx = graphContext({
      entityResolution: { isNewEntity: false, canonicalName: "Acme Logistics BV", confidence: 0.9, mergedFrom: 2 },
      priorCases: [
        { caseId: "case_7", completedAt: "2026-07-01T00:00:00Z", riskScore: "Low", summary: "Clean" },
        { caseId: "case_9", completedAt: "2026-08-01T00:00:00Z", riskScore: "Medium", summary: "Watch" },
      ],
      relatedEntities: [{ canonicalName: "Acme Holdings BV", entityType: "company", relationshipType: "controls", riskScore: null, lastSeenAt: null }],
    });
    const patch = await draftDossierNode(makeState(), { llm: client, graphQuery: fakeGraphQuery(ctx).service });

    // LLM received the graph context (2 prior cases)
    const [stateArg, graphArg] = draftDossier.mock.calls[0]!;
    expect(stateArg.caseId).toBe("case_1");
    expect((graphArg as GraphContext).priorCases).toHaveLength(2);

    // Dossier carries the graph blurb
    expect(patch.dossier).toContain("[Graph: 2 prior case(s), 1 related entities]");
  });

  it("omits the graph note for a brand-new entity", async () => {
    const { client } = fakeLlm();
    const patch = await draftDossierNode(makeState(), { llm: client, graphQuery: fakeGraphQuery(graphContext()).service });
    expect(patch.dossier).not.toContain("[Graph:");
  });

  it("upserts the resolved entity and links the case to it", async () => {
    const { client } = fakeLlm();
    const gq = fakeGraphQuery(graphContext());
    await draftDossierNode(makeState(), { llm: client, graphQuery: gq.service });
    expect(gq.upsert).toHaveBeenCalledWith(expect.objectContaining({ canonicalName: "Acme Logistics BV" }), "ten_1");
    expect(gq.getContext).toHaveBeenCalledWith("ten_1", "case_1", "Acme Logistics BV", "NL");
    expect(gq.link).toHaveBeenCalledWith("case_1", "ent_1", "subject");
  });

  it("fails open when the graph DB is unreachable — dossier still produced", async () => {
    const { client } = fakeLlm("Clean assessment.");
    const service: GraphQueryService = {
      upsertEntity: vi.fn(async () => { throw new Error("db down"); }),
      getContext: vi.fn(async () => { throw new Error("db down"); }),
      linkCaseToEntity: vi.fn(async () => {}),
    };
    const patch = await draftDossierNode(makeState(), { llm: client, graphQuery: service });
    expect(patch.dossier).toContain("Clean assessment.");
    expect(patch.dossier).not.toContain("[Graph:");
  });
});

describe("buildGraphEnhancedPrompt (Sprint 5)", () => {
  const state = makeState();

  it("embeds prior assessments for a known entity", () => {
    const prompt = buildGraphEnhancedPrompt(state, graphContext({
      entityResolution: { isNewEntity: false, canonicalName: "Acme Logistics BV", confidence: 0.9, mergedFrom: 1 },
      priorCases: [{ caseId: "case_9", completedAt: "2026-08-01T00:00:00Z", riskScore: "High", summary: "High-risk" }],
    }));
    expect(prompt).toContain("Prior assessments of this entity:");
    expect(prompt).toContain("case_9");
  });

  it("embeds related entities", () => {
    const prompt = buildGraphEnhancedPrompt(state, graphContext({
      entityResolution: { isNewEntity: false, canonicalName: "Acme Logistics BV", confidence: 0.9, mergedFrom: 1 },
      relatedEntities: [{ canonicalName: "Acme Holdings BV", entityType: "company", relationshipType: "controls", riskScore: null, lastSeenAt: null }],
    }));
    expect(prompt).toContain("Related entities in knowledge graph:");
    expect(prompt).toContain("Acme Holdings BV");
  });

  it("notes multi-source merges in the resolution text", () => {
    const prompt = buildGraphEnhancedPrompt(state, graphContext({
      entityResolution: { isNewEntity: false, canonicalName: "Acme Logistics BV", confidence: 0.9, mergedFrom: 3 },
    }));
    expect(prompt).toContain("merged from 3 source records");
  });

  it("notes when the entity has no historical context", () => {
    const prompt = buildGraphEnhancedPrompt(state, graphContext());
    expect(prompt).toContain("first time this entity has been assessed");
  });
});
