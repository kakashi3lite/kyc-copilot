/**
 * state.ts
 *
 * Defines the canonical shape of the AML/KYC agent's working memory.
 *
 * Two things live here:
 *  1. `AgentState` — a plain TypeScript interface for IDE autocompletion and
 *     type-safe node signatures.
 *  2. `AgentStateAnnotation` — the LangGraph `Annotation.Root(...)` object that
 *     tells the StateGraph *how* to merge partial state updates from each node.
 *
 * Design principles:
 *  - Every field that a node writes must have a reducer.  We use last-write-wins
 *    (`(_, y) => y`) for most fields because only one node writes each field.
 *  - The `messages` channel uses an append reducer so conversation history
 *    accumulates without nodes needing to read the full array first.
 *  - The `evidenceLedger` uses a shallow-merge reducer so nodes can add new
 *    evidence entries without overwriting existing ones — critical for auditability.
 */

// Use the main Node.js entry point — not the /web subpath export
import { Annotation } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";

// ---------------------------------------------------------------------------
// Primitive type aliases — keep them explicit for readability in compliance code
// ---------------------------------------------------------------------------

/** Risk classification aligned with AMLD6 customer risk tiers. */
export type RiskScore = "Low" | "Medium" | "High" | "Pending";

/**
 * Immutable evidence map.
 * Key:   a deterministic claim ID (e.g. "API_1", "BROWSER_SCREENSHOT_1")
 * Value: the source URL, API endpoint, or local screenshot path that backs
 *        the claim. Every [Source: KEY] citation in the dossier must have
 *        a matching entry here — the guardrail node enforces this.
 */
export type EvidenceLedger = Record<string, string>;

// ---------------------------------------------------------------------------
// AgentState — plain interface used as the node function parameter type
// ---------------------------------------------------------------------------

/**
 * The complete working memory of one KYC case.
 *
 * This interface mirrors `AgentStateAnnotation` field-for-field so TypeScript
 * can enforce type safety inside node functions without needing to import the
 * Annotation object directly.
 */
export interface AgentState {
  /** Unique case identifier (UUID v4 generated at ingest). */
  caseId: string;

  /** Legal entity name as submitted by the onboarding client. */
  companyName: string;

  /** Company registration number from the originating jurisdiction's registry. */
  registrationNumber: string;

  /** ISO 3166-1 alpha-2 country code of the company's primary jurisdiction. */
  jurisdiction: string;

  /**
   * Structured payload from the primary API lookup (OpenCorporates /
   * ComplyAdvantage mock). Null until `apiLookupNode` runs.
   */
  apiData: Record<string, unknown> | null;

  /**
   * Structured payload extracted by the Playwright browser agent from a
   * regional registry. Null when the API lookup is sufficient.
   */
  browserData: Record<string, unknown> | null;

  /**
   * Append-only map of evidence entries.
   * Every factual claim in `draftDossier` must cite a key from this map
   * using the `[Source: KEY]` citation syntax.
   */
  evidenceLedger: EvidenceLedger;

  /**
   * Markdown-formatted Enhanced Due Diligence (EDD) narrative.
   * Written by `draftDossierNode`, scrubbed by `guardrailNode`.
   */
  draftDossier: string;

  /** Current risk classification. Defaults to "Pending" until assessed. */
  riskScore: RiskScore;

  /**
   * When true, the graph routes to `humanReviewNode` before finalising.
   * Set by `guardrailNode` (unsourced claims) or `browserFallbackNode`
   * (unrecoverable scraping error).
   */
  requiresHuman: boolean;

  /**
   * Conversation history shared across LLM calls.
   * Uses an append reducer — nodes push new messages, never replace the array.
   */
  messages: BaseMessage[];
}

// ---------------------------------------------------------------------------
// AgentStateAnnotation — LangGraph channel definitions
// ---------------------------------------------------------------------------

/**
 * The LangGraph state graph reads this object to understand:
 *  - What channels (fields) exist
 *  - How to merge partial updates from node return values
 *  - What default value to use when the graph is first created
 *
 * Each channel uses one of two reducer strategies:
 *  - Last-write-wins:  `(_, incoming) => incoming`
 *  - Shallow merge:    `(existing, incoming) => ({ ...existing, ...incoming })`
 *  - Append:           `(existing, incoming) => [...existing, ...incoming]`
 */
export const AgentStateAnnotation = Annotation.Root({
  // --- Identity fields (set once at ingest, never mutated) ---

  caseId: Annotation<string>({
    reducer: (_, y) => y,
    default: () => "",
  }),

  companyName: Annotation<string>({
    reducer: (_, y) => y,
    default: () => "",
  }),

  registrationNumber: Annotation<string>({
    reducer: (_, y) => y,
    default: () => "",
  }),

  jurisdiction: Annotation<string>({
    reducer: (_, y) => y,
    default: () => "",
  }),

  // --- Data collection fields (written by lookup nodes) ---

  apiData: Annotation<Record<string, unknown> | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),

  browserData: Annotation<Record<string, unknown> | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),

  /**
   * Shallow-merge reducer: new entries are added, existing entries are never
   * deleted. This guarantees the ledger is append-only even if a node
   * accidentally returns overlapping keys (last-write-wins within a merge).
   */
  evidenceLedger: Annotation<EvidenceLedger>({
    reducer: (existing, incoming) => ({ ...existing, ...incoming }),
    default: () => ({}),
  }),

  // --- Output fields (written by dossier and guardrail nodes) ---

  draftDossier: Annotation<string>({
    reducer: (_, y) => y,
    default: () => "",
  }),

  riskScore: Annotation<RiskScore>({
    reducer: (_, y) => y,
    default: () => "Pending",
  }),

  requiresHuman: Annotation<boolean>({
    reducer: (_, y) => y,
    default: () => false,
  }),

  /**
   * Append reducer: each LLM call pushes new messages onto the history.
   * No node should replace the entire array — only append to it.
   */
  messages: Annotation<BaseMessage[]>({
    reducer: (existing, incoming) => [...existing, ...incoming],
    default: () => [],
  }),
});

// Export the inferred State type — used as the return type annotation in graph.ts
export type AgentStateType = typeof AgentStateAnnotation.State;
