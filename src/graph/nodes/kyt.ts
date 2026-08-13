/**
 * KYT graph node — Phase 3.
 *
 * Runs AFTER api/browser lookup and BEFORE dossier drafting. When the case
 * carries wallet `transactionData`, it extracts transaction features and
 * classifies the flow into a typology with per-signal contributions —
 * fully offline, CPU-only, $0.00 marginal LLM cost — and attaches a
 * `kyt-typology` evidence record to the evidence chain.
 *
 * When the case has NO transaction data (the current KYC product state),
 * this node is a transparent no-op: zero-key behavior and existing
 * pipelines are byte-for-byte unchanged.
 */

import { createHash } from "node:crypto";
import type { AgentState, AgentStatePatch } from "../state.js";
import type { EvidenceRecord } from "../../types/index.js";
import { extractFeatures } from "../../services/kyt/features.js";
import { classify } from "../../services/kyt/typology.js";

export async function kytNode(state: AgentState): Promise<AgentStatePatch> {
  const transactions = state.transactionData ?? [];
  if (transactions.length === 0) return {};

  const verdict = classify(extractFeatures(transactions));

  const summary = [
    `KYT typology: ${verdict.typology}`,
    `confidence ${verdict.confidence.toFixed(2)}`,
    `risk ${verdict.score.toFixed(2)}`,
    `signals: ${verdict.triggeredRules.slice(0, 3).join(", ")}`,
  ].join(" | ");

  const evidence: EvidenceRecord = {
    key: "kyt-typology",
    sourceUrl: "urn:kyt:deterministic",
    summary,
    kind: "system",
    capturedAt: verdict.generatedAt,
    version: 1,
    hash: createHash("sha256").update(JSON.stringify(verdict)).digest("hex"),
  };

  return { kytVerdict: verdict, evidenceLedger: { "kyt-typology": evidence } };
}
