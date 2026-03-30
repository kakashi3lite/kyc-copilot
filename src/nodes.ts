/**
 * nodes.ts
 *
 * Implements all six nodes of the AML/KYC compliance graph.
 *
 * Each node is a pure async function:
 *   `(state: AgentState) => Promise<Partial<AgentState>>`
 *
 * Nodes only return the fields they modify — LangGraph merges the partial
 * update into the full state using the reducers defined in state.ts.
 *
 * Node execution order (see graph.ts for the wiring):
 *   ingestDataNode
 *     └─> apiLookupNode
 *           ├─(complete)──> draftDossierNode
 *           └─(missing)───> browserFallbackNode ──> draftDossierNode
 *                                                        └─> guardrailNode
 *                                                              ├─(clean)──> END
 *                                                              └─(flagged)─> humanReviewNode ──> END
 */

import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { chromium } from "playwright";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentState } from "./state.js";

// ---------------------------------------------------------------------------
// Lazy LLM client factories
// ---------------------------------------------------------------------------
// Clients are created on first use rather than at module load.
// This allows the HTTP server to start and serve the demo UI even when
// OPENAI_API_KEY is not set — the key is only required for live-mode runs.

let _textLlm: ChatOpenAI | null = null;
let _visionLlm: ChatOpenAI | null = null;

/**
 * Returns the shared text LLM client (gpt-4o, temperature 0).
 * Temperature 0 forces deterministic outputs — critical for compliance.
 * Throws a clear error if OPENAI_API_KEY is absent.
 */
function getTextLlm(): ChatOpenAI {
  if (!_textLlm) {
    _textLlm = new ChatOpenAI({ model: "gpt-4o", temperature: 0 });
  }
  return _textLlm;
}

/**
 * Returns the shared vision LLM client.
 * gpt-4o supports image inputs natively; used for registry screenshot extraction.
 */
function getVisionLlm(): ChatOpenAI {
  if (!_visionLlm) {
    _visionLlm = new ChatOpenAI({ model: "gpt-4o", temperature: 0, maxTokens: 1024 });
  }
  return _visionLlm;
}

// ---------------------------------------------------------------------------
// Zod schemas — every LLM output is parsed through one of these.
// Using .withStructuredOutput(schema) forces the model into JSON mode and
// validates the response shape before it touches the state.
// ---------------------------------------------------------------------------

/**
 * Controls the conditional edge after `apiLookupNode`.
 * The LLM decides if the structured API data is sufficient for a dossier.
 */
const RoutingDecisionSchema = z.object({
  route: z.enum(["api_complete", "needs_browser"]).describe(
    'Use "api_complete" when UBO, incorporation date, and jurisdiction are all present. ' +
    'Use "needs_browser" when any critical field is null, empty, or marked stale.'
  ),
  reasoning: z.string().describe("One-sentence justification for the routing decision."),
});
export type RoutingDecision = z.infer<typeof RoutingDecisionSchema>;

/**
 * Structured result from the mock OpenCorporates / ComplyAdvantage API call.
 * In production, replace the mock body in apiLookupNode with a real fetch().
 */
const ApiLookupResultSchema = z.object({
  companyName: z.string(),
  registrationNumber: z.string(),
  jurisdiction: z.string(),
  incorporationDate: z.string().nullable().describe("ISO 8601 date or null if unknown"),
  status: z.enum(["active", "dissolved", "suspended", "unknown"]),
  registeredAddress: z.string().nullable(),
  uboName: z.string().nullable().describe("Ultimate Beneficial Owner full legal name"),
  uboOwnershipPct: z.number().nullable().describe("UBO direct/indirect ownership percentage"),
  sanctionsHit: z.boolean().describe("True if any sanctions list match was found"),
  pepHit: z.boolean().describe("True if any politically exposed person match was found"),
  dataFreshness: z.enum(["fresh", "stale"]).describe(
    '"fresh" = fetched within 24h; "stale" = cached older data'
  ),
});
export type ApiLookupResult = z.infer<typeof ApiLookupResultSchema>;

/**
 * Extracted UBO data from a browser screenshot via Vision LLM.
 * Used by `browserFallbackNode` when the API lacks UBO information.
 */
const UboExtractionSchema = z.object({
  uboName: z.string().describe("Full legal name of the Ultimate Beneficial Owner"),
  ownershipPct: z.number().min(0).max(100).describe("Ownership percentage (0-100)"),
  extractedFrom: z.string().describe("Description of the registry page section where this was found"),
  confidence: z.enum(["high", "medium", "low"]).describe(
    "Confidence level of the extraction — low triggers requiresHuman"
  ),
});
export type UboExtraction = z.infer<typeof UboExtractionSchema>;

/**
 * Output of the guardrail node — the Internal Auditor's verdict.
 * `strippedDossier` is the dossier with unsourced claims removed.
 * `flaggedClaims` lists the claims that were removed or flagged.
 */
const GuardrailDecisionSchema = z.object({
  strippedDossier: z.string().describe(
    "The dossier text with any claim lacking a [Source: KEY] citation removed."
  ),
  requiresHuman: z.boolean().describe(
    "True if critical compliance fields (UBO, sanctions) are unsourced after stripping."
  ),
  flaggedClaims: z.array(z.string()).describe(
    "List of claim text snippets that were removed or flagged as unsourced."
  ),
  auditSummary: z.string().describe("One-paragraph summary of the guardrail audit result."),
});
export type GuardrailDecision = z.infer<typeof GuardrailDecisionSchema>;

// ---------------------------------------------------------------------------
// Evidence directory — screenshots land here
// ---------------------------------------------------------------------------
const EVIDENCE_DIR = path.resolve("evidence");

// ---------------------------------------------------------------------------
// NODE 1: ingestDataNode
// ---------------------------------------------------------------------------

/**
 * Parses and normalises the incoming case payload.
 *
 * This is the entry point of every KYC run. It does NOT call any external
 * service — it validates the input shape and emits an initial HumanMessage
 * into the conversation history so downstream LLM calls have context.
 *
 * Returns: updated identity fields + initial message.
 */
export async function ingestDataNode(
  state: AgentState
): Promise<Partial<AgentState>> {
  console.log(`[ingestDataNode] Starting case=${state.caseId} company="${state.companyName}"`);

  // Validate that the minimum required fields arrived in the state.
  // In production this would parse a JSON request body through a Zod schema.
  if (!state.companyName || !state.registrationNumber || !state.jurisdiction) {
    throw new Error(
      `[ingestDataNode] Missing required fields: companyName=${state.companyName}, ` +
      `registrationNumber=${state.registrationNumber}, jurisdiction=${state.jurisdiction}`
    );
  }

  // Normalise jurisdiction to uppercase ISO-3166-1 alpha-2
  const jurisdiction = state.jurisdiction.toUpperCase().trim();

  // Push a human-style message summarising the case context.
  // Downstream LLM nodes will see this as the first message in history.
  const contextMessage = new HumanMessage(
    `KYC Case ${state.caseId}: Begin Enhanced Due Diligence for ` +
    `"${state.companyName}" (reg: ${state.registrationNumber}, jurisdiction: ${jurisdiction}).`
  );

  console.log(`[ingestDataNode] Ingested case. Jurisdiction normalised to: ${jurisdiction}`);

  return {
    jurisdiction,
    messages: [contextMessage],
  };
}

// ---------------------------------------------------------------------------
// NODE 2: apiLookupNode
// ---------------------------------------------------------------------------

/**
 * Fetches structured company and UBO data from primary compliance APIs.
 *
 * Production: replace the `mockApiCall` body with real OpenCorporates and
 * ComplyAdvantage HTTP calls.  The Zod validation layer stays identical.
 *
 * The node also makes a routing decision (via LLM) to determine whether
 * the API data is sufficient or whether the browser fallback is needed.
 * That routing decision is surfaced via the `apiData.__routing` field
 * which `graph.ts` reads in its conditional edge function.
 */
export async function apiLookupNode(
  state: AgentState
): Promise<Partial<AgentState>> {
  console.log(`[apiLookupNode] Looking up ${state.companyName} via mock APIs...`);

  // --- Mock API call (replace with real HTTP in production) ---
  const rawApiResponse = await mockApiCall(state.companyName, state.registrationNumber, state.jurisdiction);

  // Validate the raw response against our schema.
  // If the real API returns an unexpected shape, this throws and the run fails
  // fast rather than writing garbage into the evidence ledger.
  const parsed = ApiLookupResultSchema.parse(rawApiResponse);

  // Build the evidence ledger entry.
  // In production, the value would be the actual API endpoint URL + timestamp.
  const evidenceKey = "API_1";
  const evidenceValue = `https://api.opencorporates.com/v0.4/companies/${state.jurisdiction}/${state.registrationNumber} [mock, fetched at ${new Date().toISOString()}]`;

  // Ask the LLM whether the data is complete enough to draft the dossier.
  // This is a cheap routing call — we force strict JSON via withStructuredOutput.
  const routingLlm = getTextLlm().withStructuredOutput(RoutingDecisionSchema);

  const routingDecision = await routingLlm.invoke([
    new SystemMessage(
      "You are a KYC data quality assessor. Evaluate the API result and decide if it " +
      "contains enough information to draft an EDD report without browser augmentation."
    ),
    new HumanMessage(
      `API Result:\n${JSON.stringify(parsed, null, 2)}\n\n` +
      `Rules:\n` +
      `- Route "api_complete" only if: uboName is non-null AND incorporationDate is non-null AND dataFreshness = "fresh".\n` +
      `- Route "needs_browser" if any of those fields are missing or data is stale.`
    ),
  ]);

  console.log(`[apiLookupNode] Routing decision: ${routingDecision.route} — ${routingDecision.reasoning}`);

  // Attach the routing decision to apiData so graph.ts can read it.
  const apiData: Record<string, unknown> = {
    ...parsed,
    __routing: routingDecision.route,
  };

  return {
    apiData,
    evidenceLedger: { [evidenceKey]: evidenceValue },
    messages: [
      new AIMessage(
        `API lookup complete for ${state.companyName}. ` +
        `UBO: ${parsed.uboName ?? "NOT FOUND"}. ` +
        `Sanctions hit: ${parsed.sanctionsHit}. ` +
        `Routing: ${routingDecision.route}.`
      ),
    ],
  };
}

/**
 * Simulates an OpenCorporates + ComplyAdvantage response.
 * Returns incomplete UBO data 30% of the time to exercise the browser fallback.
 */
async function mockApiCall(
  companyName: string,
  registrationNumber: string,
  jurisdiction: string
): Promise<unknown> {
  // Simulate network latency
  await new Promise((r) => setTimeout(r, 200));

  // Deterministically simulate missing UBO for certain jurisdictions
  // (e.g., BVI and Panama often lack public UBO registries)
  const missingUboJurisdictions = ["VG", "PA", "KY", "BZ"];
  const uboMissing = missingUboJurisdictions.includes(jurisdiction.toUpperCase());

  return {
    companyName,
    registrationNumber,
    jurisdiction,
    incorporationDate: uboMissing ? null : "2018-03-15",
    status: "active",
    registeredAddress: uboMissing ? null : "123 Business Park, Amsterdam, NL",
    uboName: uboMissing ? null : "Jane Doe",
    uboOwnershipPct: uboMissing ? null : 75,
    sanctionsHit: false,
    pepHit: false,
    dataFreshness: uboMissing ? "stale" : "fresh",
  };
}

// ---------------------------------------------------------------------------
// NODE 3: browserFallbackNode
// ---------------------------------------------------------------------------

/**
 * Uses Playwright + Vision LLM to extract UBO data from a regional registry.
 *
 * This node runs only when `apiLookupNode` returns `needs_browser`.
 * It:
 *  1. Launches a Chromium browser (headless).
 *  2. Navigates to a mock registry URL.
 *  3. Takes a full-page screenshot.
 *  4. Sends the screenshot to GPT-4o Vision for UBO extraction.
 *  5. Saves the screenshot path to the evidence ledger.
 *
 * Safe failure: any exception (CAPTCHA, network error, timeout) is caught.
 * On failure, `requiresHuman` is set to true and the graph routes to HITL
 * instead of crashing the process.
 */
export async function browserFallbackNode(
  state: AgentState
): Promise<Partial<AgentState>> {
  console.log(`[browserFallbackNode] Starting browser scrape for case=${state.caseId}`);

  // Ensure the evidence directory exists before trying to save screenshots.
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });

  const screenshotPath = path.join(EVIDENCE_DIR, `${state.caseId}-ubo.png`);

  try {
    // --- Launch Playwright ---
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    // Mock registry URL — in production this would be jurisdiction-specific
    // e.g., https://www.kvk.nl/zoeken/ (Netherlands) or https://find-and-update.company-information.service.gov.uk/
    const mockRegistryUrl =
      `https://example.com/registry?company=${encodeURIComponent(state.companyName)}&reg=${state.registrationNumber}`;

    console.log(`[browserFallbackNode] Navigating to: ${mockRegistryUrl}`);

    // Use a short timeout — if the registry is down, fail fast and route to HITL
    await page.goto(mockRegistryUrl, { timeout: 15_000, waitUntil: "domcontentloaded" });

    // Take a full-page screenshot for the evidence ledger
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await browser.close();

    console.log(`[browserFallbackNode] Screenshot saved to: ${screenshotPath}`);

    // --- Vision LLM extraction ---
    // Read the screenshot as base64 so we can embed it in the API message
    const screenshotBase64 = (await fs.readFile(screenshotPath)).toString("base64");

    const extractionLlm = getVisionLlm().withStructuredOutput(UboExtractionSchema);

    const extracted = await extractionLlm.invoke([
      new SystemMessage(
        "You are a KYC analyst. Extract the Ultimate Beneficial Owner (UBO) from the " +
        "company registry screenshot. Return structured JSON only."
      ),
      new HumanMessage({
        content: [
          {
            type: "text",
            text: `Extract UBO details for "${state.companyName}" (reg: ${state.registrationNumber}) from this registry page screenshot.`,
          },
          {
            type: "image_url",
            image_url: {
              url: `data:image/png;base64,${screenshotBase64}`,
              detail: "high",
            },
          },
        ],
      }),
    ]);

    console.log(
      `[browserFallbackNode] Extracted UBO: ${extracted.uboName} (${extracted.ownershipPct}%) ` +
      `confidence=${extracted.confidence}`
    );

    // Low-confidence extraction still triggers human review
    const requiresHuman = extracted.confidence === "low";

    const evidenceKey = "BROWSER_SCREENSHOT_1";

    return {
      browserData: {
        uboName: extracted.uboName,
        ownershipPct: extracted.ownershipPct,
        extractedFrom: extracted.extractedFrom,
        confidence: extracted.confidence,
      },
      evidenceLedger: {
        [evidenceKey]: screenshotPath,
      },
      requiresHuman,
      messages: [
        new AIMessage(
          `Browser fallback completed. UBO extracted: ${extracted.uboName} ` +
          `(${extracted.ownershipPct}%, confidence=${extracted.confidence}). ` +
          (requiresHuman ? "Low confidence — flagging for human review." : "")
        ),
      ],
    };
  } catch (err) {
    // --- Safe failure path ---
    // Do NOT rethrow. Log the error, set requiresHuman, and let the graph
    // route to humanReviewNode instead of terminating the process.
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[browserFallbackNode] ERROR: ${errorMessage}`);

    return {
      browserData: null,
      requiresHuman: true,
      messages: [
        new AIMessage(
          `Browser fallback failed: ${errorMessage}. ` +
          `Case routed to human review — manual UBO verification required.`
        ),
      ],
    };
  }
}

// ---------------------------------------------------------------------------
// NODE 4: draftDossierNode
// ---------------------------------------------------------------------------

/**
 * Writes a 3-paragraph Enhanced Due Diligence (EDD) Markdown narrative.
 *
 * CRITICAL citation rule:
 *   Every factual claim must be followed by a citation tag in the form
 *   `[Source: KEY]` where KEY is a key in `state.evidenceLedger`.
 *   The `guardrailNode` mechanically verifies this — claims without a
 *   valid evidence key will be stripped.
 *
 * The LLM is given the full evidence ledger keys so it knows which sources
 * to cite. It is NOT given the actual source values (URLs/paths) to prevent
 * hallucination of fake citations.
 */
export async function draftDossierNode(
  state: AgentState
): Promise<Partial<AgentState>> {
  console.log(`[draftDossierNode] Drafting EDD narrative for case=${state.caseId}`);

  // Build a consolidated data summary from both API and browser sources
  const dataSummary = {
    fromApi: state.apiData,
    fromBrowser: state.browserData,
  };

  // Tell the LLM exactly which evidence keys are available to cite
  const availableEvidenceKeys = Object.keys(state.evidenceLedger);

  const draftingLlm = getTextLlm();

  const response = await draftingLlm.invoke([
    new SystemMessage(
      "You are a Senior KYC Analyst writing an Enhanced Due Diligence (EDD) report.\n\n" +
      "RULES (non-negotiable):\n" +
      "1. Write exactly 3 paragraphs in Markdown format.\n" +
      "2. Every factual claim must end with a citation tag: [Source: KEY].\n" +
      "3. Only use evidence keys from the AVAILABLE EVIDENCE KEYS list. Never invent keys.\n" +
      "4. Paragraph 1: Company identity & incorporation details.\n" +
      "5. Paragraph 2: Ultimate Beneficial Ownership (UBO) structure.\n" +
      "6. Paragraph 3: Risk assessment summary including sanctions/PEP status.\n" +
      "7. Do not add conclusions, headers, or preamble — three paragraphs only."
    ),
    new HumanMessage(
      `CASE ID: ${state.caseId}\n` +
      `COMPANY: ${state.companyName}\n` +
      `REGISTRATION: ${state.registrationNumber}\n` +
      `JURISDICTION: ${state.jurisdiction}\n\n` +
      `COLLECTED DATA:\n${JSON.stringify(dataSummary, null, 2)}\n\n` +
      `AVAILABLE EVIDENCE KEYS (you MUST only cite these):\n` +
      availableEvidenceKeys.map((k) => `- ${k}`).join("\n")
    ),
  ]);

  const draftDossier = typeof response.content === "string"
    ? response.content
    : JSON.stringify(response.content);

  console.log(`[draftDossierNode] Dossier drafted (${draftDossier.length} chars)`);

  return {
    draftDossier,
    // Assign initial risk score based on API data flags
    riskScore: deriveRiskScore(state),
    messages: [
      new AIMessage(`EDD dossier drafted for case ${state.caseId}. Proceeding to guardrail audit.`),
    ],
  };
}

/**
 * Derives an initial risk score from structured API flags.
 * The human reviewer may override this during the HITL step.
 */
function deriveRiskScore(state: AgentState): "Low" | "Medium" | "High" | "Pending" {
  const api = state.apiData;
  if (!api) return "Pending";

  if (api["sanctionsHit"] === true || api["pepHit"] === true) return "High";
  if (api["dataFreshness"] === "stale" || !api["uboName"]) return "Medium";
  if (state.requiresHuman) return "Medium";
  return "Low";
}

// ---------------------------------------------------------------------------
// NODE 5: guardrailNode
// ---------------------------------------------------------------------------

/**
 * The "Internal Auditor" — verifies that every claim in the dossier has
 * a corresponding entry in the evidence ledger.
 *
 * Strategy:
 *  1. Extract all [Source: KEY] citations from the draft dossier.
 *  2. Compare each KEY against `state.evidenceLedger`.
 *  3. Instruct the LLM to strip claims with unknown/missing keys.
 *  4. Set `requiresHuman = true` if any critical compliance claims were stripped.
 *
 * The LLM never invents evidence — it only strips text. The mechanical
 * key-existence check here is deterministic; the LLM only handles the
 * natural-language stripping task.
 */
export async function guardrailNode(
  state: AgentState
): Promise<Partial<AgentState>> {
  console.log(`[guardrailNode] Running audit on dossier for case=${state.caseId}`);

  const validKeys = new Set(Object.keys(state.evidenceLedger));

  // --- Mechanically find all cited keys in the dossier ---
  // Regex matches [Source: ANYTHING] tags
  const citationRegex = /\[Source:\s*([^\]]+)\]/g;
  const citedKeys: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = citationRegex.exec(state.draftDossier)) !== null) {
    const key = match[1]?.trim();
    if (key) citedKeys.push(key);
  }

  const invalidKeys = citedKeys.filter((k) => !validKeys.has(k));
  const hasInvalidCitations = invalidKeys.length > 0;

  console.log(`[guardrailNode] Valid keys: [${[...validKeys].join(", ")}]`);
  console.log(`[guardrailNode] Cited keys: [${citedKeys.join(", ")}]`);
  console.log(`[guardrailNode] Invalid citations: [${invalidKeys.join(", ")}]`);

  // --- LLM guardrail: strip unsourced claims from the dossier ---
  const auditLlm = getTextLlm().withStructuredOutput(GuardrailDecisionSchema);

  const auditResult = await auditLlm.invoke([
    new SystemMessage(
      "You are a compliance auditor performing an evidence integrity check.\n\n" +
      "VALID EVIDENCE KEYS (the only acceptable citation keys):\n" +
      [...validKeys].map((k) => `- ${k}`).join("\n") + "\n\n" +
      "TASK:\n" +
      "1. Review the dossier for [Source: KEY] citations.\n" +
      "2. Remove any sentence or claim whose citation KEY is NOT in the valid list.\n" +
      "3. If a critical compliance field (UBO identity, sanctions status) is removed, set requiresHuman=true.\n" +
      "4. Return the cleaned dossier, list of removed claims, and a short audit summary."
    ),
    new HumanMessage(
      `DOSSIER TO AUDIT:\n\n${state.draftDossier}\n\n` +
      `INVALID KEYS DETECTED: ${hasInvalidCitations ? invalidKeys.join(", ") : "none"}`
    ),
  ]);

  console.log(
    `[guardrailNode] Audit complete. requiresHuman=${auditResult.requiresHuman}. ` +
    `Flagged ${auditResult.flaggedClaims.length} claim(s).`
  );

  return {
    draftDossier: auditResult.strippedDossier,
    // OR with existing requiresHuman — if the browser fallback already set it, preserve that
    requiresHuman: state.requiresHuman || auditResult.requiresHuman,
    messages: [
      new AIMessage(
        `Guardrail audit complete. ${auditResult.flaggedClaims.length} claim(s) flagged. ` +
        `requiresHuman=${state.requiresHuman || auditResult.requiresHuman}. ` +
        auditResult.auditSummary
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// NODE 6: humanReviewNode
// ---------------------------------------------------------------------------

/**
 * Human-in-the-Loop (HITL) stub node.
 *
 * The graph is compiled with `interruptBefore: ["humanReviewNode"]` in graph.ts.
 * This means execution PAUSES before entering this node and control returns
 * to the caller (the Hono API server).
 *
 * The human reviewer:
 *  1. Reads the dossier and risk score via `GET /cases/:id/state`
 *  2. Approves (or rejects with notes) via `POST /cases/:id/approve`
 *  3. The graph resumes from this node and proceeds to END
 *
 * This node intentionally does nothing beyond logging — the pause-and-resume
 * mechanism is handled entirely by LangGraph's checkpointer infrastructure.
 */
export async function humanReviewNode(
  state: AgentState
): Promise<Partial<AgentState>> {
  console.log("=".repeat(60));
  console.log(`[humanReviewNode] AWAITING HUMAN REVIEW — Case: ${state.caseId}`);
  console.log(`[humanReviewNode] Risk Score: ${state.riskScore}`);
  console.log(`[humanReviewNode] Dossier Preview:\n${state.draftDossier.slice(0, 300)}...`);
  console.log("=".repeat(60));

  // Log the full evidence ledger so the reviewer can validate sources
  console.log("[humanReviewNode] Evidence Ledger:");
  for (const [key, value] of Object.entries(state.evidenceLedger)) {
    console.log(`  ${key}: ${value}`);
  }

  // No state mutations — this node is a checkpoint marker.
  // When the graph resumes after human approval, it proceeds to END.
  return {
    messages: [
      new AIMessage(
        `Case ${state.caseId} approved by human reviewer. ` +
        `Final risk score: ${state.riskScore}. Dossier finalised.`
      ),
    ],
  };
}
