/**
 * Deterministic difficulty classifier — Sprint 3.
 *
 * Routes each dossier task to a cost-optimized model tier based on case
 * complexity, BEFORE any LLM call. No ML, no I/O — a pure function over
 * the graph state.
 *
 * Rationale: a simple company with complete registry data, no sanctions,
 * no PEP and a low-risk jurisdiction does not need GPT-4o. Routing those
 * to t0 (deterministic) or t2 (cheap LLM) targets the "≥60% of LLM calls
 * use t0–t2" benchmark without quality degradation, because the tier
 * assignment is driven by the same signals a human analyst would weigh.
 *
 * Tier assignment rules (evaluated in order):
 *   1. Sanctions or PEP flag       → t4 (needs best reasoning)
 *   2. Blacklisted jurisdiction    → t4 (even with complete data)
 *   3. Elevated jurisdiction + partial data → t4
 *   4. Complete + low-risk + all UBOs verified → t0 (deterministic)
 *   5. Complete + low-risk         → t2
 *   6. Very large context (>120K)  → t3 (Gemini Flash 1M context)
 *   7. Default                     → t2
 */

import { z } from "zod";
import type { AgentState } from "../../graph/state.js";

/** Features extracted from AgentState for difficulty classification. */
export const DifficultyFeaturesSchema = z.object({
  jurisdictionRiskScore: z.number().min(0).max(1),     // 0=low risk, 1=blacklisted
  hasSanctionsHit: z.boolean(),
  hasPepFlag: z.boolean(),
  dataCompleteness: z.number().min(0).max(1),           // 1=complete
  uboCount: z.number().int().min(0),
  uboVerifiedFraction: z.number().min(0).max(1),
  evidenceSourceCount: z.number().int().min(0),
  priorCaseCount: z.number().int().min(0),              // cross-case entities (populated by RAG-Graph)
  estimatedTokenCount: z.number().int().min(0),
});
export type DifficultyFeatures = z.infer<typeof DifficultyFeaturesSchema>;

/** Tier assignment with confidence. */
export const TierAssignmentSchema = z.object({
  tier: z.enum(["t0", "t1", "t2", "t3", "t4"]),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});
export type TierAssignment = z.infer<typeof TierAssignmentSchema>;

export interface DifficultyClassifier {
  /** Extract features from graph state. Pure function, no I/O. */
  extractFeatures(state: AgentState): DifficultyFeatures;
  /** Classify task complexity → tier assignment. Deterministic. */
  classify(features: DifficultyFeatures): TierAssignment;
}

// Jurisdiction risk tiers — mirrors the blacklist/greylist in client.ts
const BLACKLIST = new Set(["KP", "IR", "MM"]);
const GREYLIST = new Set(["BG", "HR", "CD", "HT", "ML", "MZ", "NA", "NG", "PH", "SN", "SS", "SY", "TZ", "VE", "VN", "YE"]);

export class DeterministicDifficultyClassifier implements DifficultyClassifier {
  public extractFeatures(state: AgentState): DifficultyFeatures {
    const jurisdictionRisk = BLACKLIST.has(state.jurisdiction) ? 1.0
      : GREYLIST.has(state.jurisdiction) ? 0.5 : 0.0;

    const sanctionsHit = state.apiData?.sanctions.some(s => s.matched) ?? false;
    const pepFlag = state.apiData?.pep ?? false;
    const uboCount = state.apiData?.ubos.length ?? 0;
    const uboVerifiedCount = state.apiData?.ubos.filter(u => u.verified).length ?? 0;
    const dataCompleteness = state.apiData?.completeness === "complete" ? 1.0 : 0.5;
    const evidenceCount = Object.keys(state.evidenceLedger).length;

    return {
      jurisdictionRiskScore: jurisdictionRisk,
      hasSanctionsHit: sanctionsHit,
      hasPepFlag: pepFlag,
      dataCompleteness,
      uboCount,
      uboVerifiedFraction: uboCount > 0 ? uboVerifiedCount / uboCount : 0,
      evidenceSourceCount: evidenceCount,
      priorCaseCount: 0, // placeholder — populated when RAG-Graph is built
      estimatedTokenCount: Math.max(1, Math.ceil(JSON.stringify(state).length / 4)),
    };
  }

  public classify(features: DifficultyFeatures): TierAssignment {
    // Rule 1: Any sanctions hit or PEP → t4 (needs best reasoning)
    if (features.hasSanctionsHit || features.hasPepFlag) {
      return { tier: "t4", confidence: 0.95, reason: "sanctions or PEP flag requires best model" };
    }

    // Rule 2: Blacklisted jurisdiction (KP/IR/MM) → t4 regardless of completeness.
    // A sanctioned jurisdiction demands best-model reasoning even with complete
    // registry data — cost optimization never applies to blacklisted states.
    if (features.jurisdictionRiskScore >= 1.0) {
      return { tier: "t4", confidence: 0.90, reason: "blacklisted jurisdiction requires best model" };
    }

    // Rule 3: High-risk jurisdiction + incomplete data → t4
    if (features.jurisdictionRiskScore >= 0.5 && features.dataCompleteness < 1.0) {
      return { tier: "t4", confidence: 0.85, reason: "elevated jurisdiction with partial data" };
    }

    // Rule 4: Complete data + low-risk jurisdiction + no flags → t0 (deterministic)
    if (features.dataCompleteness >= 1.0 && features.jurisdictionRiskScore === 0 && features.uboVerifiedFraction >= 1.0) {
      return { tier: "t0", confidence: 0.90, reason: "complete data, low risk, all UBOs verified" };
    }

    // Rule 5: Complete data + low-risk jurisdiction (UBOs not all verified) → t2
    if (features.dataCompleteness >= 1.0 && features.jurisdictionRiskScore === 0) {
      return { tier: "t2", confidence: 0.80, reason: "complete data, low risk, minor UBO gaps" };
    }

    // Rule 6: Very large evidence context → t3 (Gemini Flash for 1M context)
    if (features.estimatedTokenCount > 120_000) {
      return { tier: "t3", confidence: 0.85, reason: "large evidence context" };
    }

    // Default: t2 for everything else
    return { tier: "t2", confidence: 0.70, reason: "standard complexity, routing to cost-optimized tier" };
  }
}