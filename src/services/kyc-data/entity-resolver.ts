/**
 * Deterministic entity resolution — Sprint 4.
 *
 * "John Smith" from OpenCorporates and "JOHN SMITH" from ComplyAdvantage
 * should be recognized as the same entity; without resolution the graph
 * fills with duplicate nodes. This resolver uses deterministic scoring
 * (registration number match, jurisdiction match, name similarity) BEFORE
 * any LLM sees the data — no ML, no I/O, a pure function.
 *
 * Scoring (weighted sum, threshold 0.70):
 *   - Registration number exact match:  40 pts
 *   - Jurisdiction exact match:         25 pts
 *   - Name Jaro-Winkler > 0.90:        25 pts
 *   - Name Jaro-Winkler > 0.70:        10 pts
 *   → Max: 90 pts. Normalized to 0.0–1.0.
 */

import { z } from "zod";
import type { ApiCompanyData } from "../../types/index.js";

/** A resolved entity with cross-source reconciliation. */
export const ResolvedEntitySchema = z.object({
  canonicalName: z.string(),
  registrationNumber: z.string(),
  jurisdiction: z.string().length(2),
  sources: z.array(z.object({
    sourceName: z.string(),          // "opencorporates" | "complyadvantage" | "browser"
    name: z.string(),
    matchConfidence: z.number().min(0).max(1),
  })),
  confidence: z.number().min(0).max(1),  // overall resolution confidence
  conflicts: z.array(z.object({
    field: z.string(),
    sourceValues: z.record(z.string()),
  })),
});
export type ResolvedEntity = z.infer<typeof ResolvedEntitySchema>;

export interface EntityResolver {
  /** Resolve a single entity across all data sources. */
  resolve(apiData: ApiCompanyData, browserData?: ApiCompanyData | null): ResolvedEntity;
}

/**
 * Name similarity. Simple implementation — for production, use a proper
 * library (e.g. the `natural` npm package) but avoid the dependency for
 * now. Tiers:
 *   - exact (case/whitespace-normalized)           → 1.0
 *   - equal after legal-suffix + non-alnum strip  → 0.95
 *   - character bigram Jaccard overlap            → 0.0–1.0
 */
export function jaroWinkler(a: string, b: string): number {
  const aNorm = a.toLowerCase().trim();
  const bNorm = b.toLowerCase().trim();
  if (aNorm === bNorm) return 1.0;

  // Exact match after basic normalization (drop legal suffixes, punctuation)
  const stripEntity = (s: string) => s
    .replace(/\b(ltd|limited|inc|llc|corp|corporation|gmbh|ag|sa|nv|bv|sarl|srl|plc|pty)\b/gi, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
  const aStripped = stripEntity(aNorm);
  const bStripped = stripEntity(bNorm);
  if (aStripped === bStripped) return 0.95;

  // Character bigram overlap as a cheap fuzzy match
  const bigrams = (s: string): Set<string> => {
    const result = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) result.add(s.slice(i, i + 2));
    return result;
  };
  const aBigrams = bigrams(aStripped);
  const bBigrams = bigrams(bStripped);
  if (aBigrams.size === 0 && bBigrams.size === 0) return 0.0;
  const intersection = new Set([...aBigrams].filter(x => bBigrams.has(x)));
  const union = new Set([...aBigrams, ...bBigrams]);
  return union.size === 0 ? 0.0 : intersection.size / union.size;
}

export class DeterministicEntityResolver implements EntityResolver {
  /**
   * Resolve entity identity across data sources. The OpenCorporates record
   * is the primary source; the browser capture (when present) is scored
   * against it. Overall confidence is the mean of per-source confidences,
   * rounded to 2 decimals.
   */
  public resolve(apiData: ApiCompanyData, browserData?: ApiCompanyData | null): ResolvedEntity {
    const sources: ResolvedEntity["sources"] = [{
      sourceName: "opencorporates",
      name: apiData.legalName,
      matchConfidence: 1.0,
    }];

    const conflicts: ResolvedEntity["conflicts"] = [];

    if (browserData) {
      const nameScore = jaroWinkler(apiData.legalName, browserData.legalName);
      const regMatch = apiData.registrationNumber === browserData.registrationNumber ? 40 : 0;
      const jurMatch = apiData.jurisdiction === browserData.jurisdiction ? 25 : 0;
      const nameMatch = nameScore > 0.90 ? 25 : nameScore > 0.70 ? 10 : 0;
      const totalScore = (regMatch + jurMatch + nameMatch) / 90;

      sources.push({
        sourceName: "browser",
        name: browserData.legalName,
        matchConfidence: totalScore,
      });

      if (totalScore < 0.70) {
        conflicts.push({
          field: "legalName",
          sourceValues: { opencorporates: apiData.legalName, browser: browserData.legalName },
        });
      }
    }

    const avgConfidence = sources.reduce((sum, s) => sum + s.matchConfidence, 0) / sources.length;

    return {
      canonicalName: apiData.legalName,
      registrationNumber: apiData.registrationNumber,
      jurisdiction: apiData.jurisdiction,
      sources,
      confidence: Math.round(avgConfidence * 100) / 100,
      conflicts,
    };
  }
}
