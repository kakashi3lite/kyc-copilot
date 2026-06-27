/**
 * Deterministic, zero-cost LLM mock for CI.
 *
 * Why this exists
 * ---------------
 * The `DynamicLlmRouter` (src/services/llm/router.ts) normally reaches
 * out to OpenAI / Anthropic / Google / Ollama. In CI that means:
 *   - $ per test run (real API calls)
 *   - Rate-limit failures on shared CI infra
 *   - Non-deterministic flakiness (model temperature, network jitter)
 *
 * This setup file replaces every LangChain adapter module with a stub
 * that returns a fixed, schema-compliant `DossierDraft`. The router's
 * `pickModel()` selection logic still runs (so tier routing tests stay
 * honest), but no network call is ever made.
 *
 * Wired into Vitest via:
 *   vitest.config.ts → test.setupFiles
 *   package.json test scripts → "--setupFiles ./tests/setup/llm-mock.ts"
 *
 * Re-declared in the suite via:
 *   `vi.mock("@langchain/openai", () => import("../setup/llm-mock").then(m => m.langchainOpenAiStub))`
 * for tests that want per-test tier overrides.
 */

import { vi } from "vitest";
import type { AgentState } from "../../src/graph/state.js";
import type { DossierDraft } from "../../src/services/llm/client.js";

/**
 * Deterministic dossier — fully schema-compliant, no network calls,
 * no randomness. The risk score is derived from jurisdiction so tier-
 * routing tests still produce distinct outputs per case.
 */
function deterministicDossier(state: AgentState): DossierDraft {
  const company = state.companyName.trim();
  const blacklist = new Set(["KP", "IR", "MM"]);
  const greylist = new Set(["BG", "HR", "CD", "HT", "ML", "MZ", "NA", "NG", "PH", "SN", "SS", "SY", "TZ", "VE", "VN", "YE"]);
  const apiKey = "API_MOCK_1";
  const riskScore = blacklist.has(state.jurisdiction)
    ? "High"
    : greylist.has(state.jurisdiction) || !state.uboVerified
      ? "Medium"
      : "Low";
  return {
    claims: [
      { id: "claim-status", text: `Registry status is ${state.apiData?.status ?? "unknown"}. [Source: ${apiKey}]`, sourceKey: apiKey },
      { id: "claim-ubo", text: state.uboVerified ? "UBO verified. [Source: API_1]" : "UBO requires verification. [Source: API_1]", sourceKey: "API_1" },
      { id: "claim-screening", text: "Screening returned no sanctions match. [Source: API_1]", sourceKey: "API_1" }
    ],
    riskScore,
    summary: `${company} was assessed under mock CDD controls. [Source: ${apiKey}]`
  };
}

/**
 * Stub factory used by vi.mock("@langchain/openai", () => langchainOpenAiStub)
 * and friends. Each LangChain adapter exports a `ChatX` class whose
 * `.invoke()` returns an AIMessage-like object. Our deterministic stub
 * satisfies whatever the router pulls off it.
 */
function makeAdapterStub(_providerName: string) {
  const invoke = vi.fn(async () => ({
    content: JSON.stringify(deterministicDossier({
      caseId: "mock",
      tenantId: "mock",
      companyName: "Mock Corp",
      registrationNumber: "MOCK123",
      jurisdiction: "US",
      uboVerified: true,
      // Whatever else the AgentState requires; the router only reads the
      // fields used by deterministicDossier, so the rest can be empty.
    } as unknown as AgentState)),
    // Some LangChain versions also inspect tool_calls / response_metadata
    tool_calls: [],
    response_metadata: {}
  }));
  return {
    ChatProvider: class {
      public invoke = invoke;
      public bindTools = vi.fn(() => this);
      public pipe = vi.fn(() => this);
    },
    HumanMessage: class { constructor(public content: string) {} },
    SystemMessage: class { constructor(public content: string) {} }
  };
}

export const langchainOpenAiStub = makeAdapterStub("openai");
export const langchainAnthropicStub = makeAdapterStub("anthropic");
export const langchainGoogleStub = makeAdapterStub("google");
export const langchainOllamaStub = makeAdapterStub("ollama");

/**
 * Stub the DynamicLlmRouter itself so the suite never even instantiates
 * a real LangChain adapter. `pickModel()` and `draftDossier()` are
 * intercepted directly.
 *
 * Per-test override pattern (used in tests that exercise tier routing):
 *   import { vi } from "vitest";
 *   vi.doMock("../../src/services/llm/router.js", async () => {
 *     const real = await vi.importActual<typeof import("../../src/services/llm/router.js")>(
 *       "../../src/services/llm/router.js"
 *     );
 *     return {
 *       ...real,
 *       DynamicLlmRouter: class extends real.DynamicLlmRouter {
 *         public async draftDossier(state: AgentState) {
 *           return deterministicDossier(state);
 *         }
 *       }
 *     };
 *   });
 */
export function makeLlmMock() {
  return {
    DynamicLlmRouter: class {
      public pickModel = vi.fn(() => ({ tier: "t0", name: "Deterministic", modelId: "deterministic" }));
      public draftDossier = vi.fn(async (state: AgentState) => deterministicDossier(state));
    }
  };
}

// ── Module-level vi.mock registrations ──────────────────────────────────
// These run automatically when this file is loaded as a Vitest setup file.
// The `@langchain/*` packages are lazy-required inside the router, so
// mocking them here covers the cold path; the `DynamicLlmRouter` mock
// is a belt-and-braces guarantee that no real network call ever happens.

vi.mock("@langchain/openai", () => langchainOpenAiStub);
vi.mock("@langchain/anthropic", () => langchainAnthropicStub);
vi.mock("@langchain/google-genai", () => langchainGoogleStub);
vi.mock("@langchain/ollama", () => langchainOllamaStub);
vi.mock("@langchain/core/messages", () => ({
  HumanMessage: class { constructor(public content: string) {} },
  SystemMessage: class { constructor(public content: string) {} }
}));