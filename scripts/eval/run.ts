/**
 * Evaluation benchmark runner — PLAN_PRODUCTION_READINESS Phase 2.
 *
 * Runs the REAL production implementations (DeterministicEntityResolver,
 * DeterministicDifficultyClassifier) against the golden datasets, prints a
 * summary, writes `tests/evaluation/reports/latest.json`, and exits non-zero
 * when any gate fails. Wired into package.json as `bench:eval`,
 * `bench:router`, `bench:graph`.
 *
 * Usage:
 *   npm run bench:eval             # all subsystems
 *   npm run bench:router           # cost-router only
 *   npm run bench:graph            # rag-graph only
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DeterministicEntityResolver } from "../../src/services/kyc-data/entity-resolver.js";
import { DeterministicDifficultyClassifier } from "../../src/services/llm/difficulty-classifier.js";
import { extractFeatures } from "../../src/services/kyt/features.js";
import { classify as classifyKyt } from "../../src/services/kyt/typology.js";
import { generateWalletTransactions } from "../../tests/fixtures/transactions-synthetic.js";
import type { ApiCompanyData } from "../../src/types/index.js";
import type { KytProfileName } from "../../src/types/kyt.js";
import type { LlmTier } from "../../src/config/llm-providers.js";
import {
  EntityResolutionGoldenSchema,
  RouterGoldenSchema,
  KytGoldenSchema,
  entityResolutionMetrics,
  routerMetrics,
  simulateCacheHits,
  estimateDossierCost,
  allAtTierCost,
  evaluateCostResult,
  kytMetrics,
  serializeReport,
  type EntityPair,
  type RouterFeatures,
  type EvaluationReport,
} from "../../tests/evaluation/harness.js";

const DATASETS = resolve(process.cwd(), "tests", "evaluation", "datasets");
const REPORT_DIR = resolve(process.cwd(), "tests", "evaluation", "reports");

const resolver = new DeterministicEntityResolver();
const classifier = new DeterministicDifficultyClassifier();

const args = new Set(process.argv.slice(2));
const runGraph = args.has("--graph") || args.size === 0;
const runRouter = args.has("--router") || args.size === 0;
const runKyt = args.has("--kyt") || args.size === 0;

const resolvePair: (a: EntityPair, b: EntityPair) => number | null = (a, b) => {
  // EntityPair is a structural subset of ApiCompanyData — the cast is safe.
  const resolved = resolver.resolve(a as unknown as ApiCompanyData, b as unknown as ApiCompanyData);
  const browser = resolved.sources.find((s) => s.sourceName === "browser");
  return browser?.matchConfidence ?? null;
};

const classify: (f: RouterFeatures) => LlmTier = (f) => classifier.classify(f).tier;

function loadRouterGolden() {
  const raw = readFileSync(resolve(DATASETS, "cost-router-golden.json"), "utf8");
  return RouterGoldenSchema.parse(JSON.parse(raw));
}

function loadEntityGolden() {
  const raw = readFileSync(resolve(DATASETS, "entity-resolution-golden.json"), "utf8");
  return EntityResolutionGoldenSchema.parse(JSON.parse(raw));
}

function loadKytGolden() {
  const raw = readFileSync(resolve(DATASETS, "kyt-golden.json"), "utf8");
  return KytGoldenSchema.parse(JSON.parse(raw));
}

function main(): void {
  const results: EvaluationReport["results"] = [];

  if (runGraph) {
    const ds = loadEntityGolden();
    const m = entityResolutionMetrics(ds.groups, resolvePair, ds.resolverThreshold);
    results.push({ subsystem: "rag-graph", metric: "entity-resolution-f1", baseline: 0.9, current: m.f1, delta: m.f1 - 0.9, passed: m.f1 > 0.9 });
    results.push({ subsystem: "rag-graph", metric: "entity-resolution-precision", baseline: 1, current: m.precision, delta: m.precision - 1, passed: m.precision === 1 });
    results.push({ subsystem: "rag-graph", metric: "entity-resolution-recall", baseline: 1, current: m.recall, delta: m.recall - 1, passed: m.recall === 1 });
    console.log(
      `[rag-graph] groups=${ds.groups.length} precision=${m.precision.toFixed(3)} recall=${m.recall.toFixed(3)} f1=${m.f1.toFixed(3)} tp=${m.truePositive} fp=${m.falsePositive} fn=${m.falseNegative}`,
    );
  }

  if (runRouter) {
    const ds = loadRouterGolden();
    const m = routerMetrics(ds.cases, classify);
    const cache = simulateCacheHits(ds.cases);
    const perCasePredicted = estimateDossierCost(ds.cases, m.predictedTiers) / ds.cases.length;
    const perCaseWorst = allAtTierCost(ds.cases, "t4") / ds.cases.length;
    results.push({ subsystem: "cost-router", metric: "tier-agreement", baseline: 0.85, current: m.agreement, delta: m.agreement - 0.85, passed: m.agreement >= 0.85 });
    results.push({ subsystem: "cost-router", metric: "low-cost-tier-ratio", baseline: 0.6, current: m.lowCostTierRatio, delta: m.lowCostTierRatio - 0.6, passed: m.lowCostTierRatio >= 0.6 });
    results.push({ subsystem: "cost-router", metric: "cache-hit-rate", baseline: 0.15, current: cache.rate, delta: cache.rate - 0.15, passed: cache.rate >= 0.15 });
    results.push(evaluateCostResult("cost-router", "cost-per-dossier-usd", perCaseWorst, perCasePredicted));
    console.log(
      `[cost-router] cases=${ds.cases.length} agreement=${m.agreement.toFixed(3)} lowCostRatio=${m.lowCostTierRatio.toFixed(3)} cacheHit=${cache.rate.toFixed(3)} cost=${perCasePredicted.toFixed(4)}/dossier vs ${perCaseWorst.toFixed(4)} all-t4`,
    );
    for (const mm of m.mismatches) {
      console.log(`  MISMATCH ${mm.caseId}: expected ${mm.expected}, predicted ${mm.predicted}`);
    }
  }

  if (runKyt) {
    const ds = loadKytGolden();
    const predictions = ds.wallets.map((w) => {
      const verdict = classifyKyt(extractFeatures(generateWalletTransactions(w.profile as KytProfileName, w.seed)));
      return { walletId: w.walletId, predicted: verdict.typology };
    });
    const m = kytMetrics(
      predictions,
      ds.wallets.map((w) => ({ walletId: w.walletId, expected: w.expectedTypology })),
    );
    results.push({ subsystem: "kyt-classifier", metric: "macro-f1", baseline: 0.85, current: m.macroF1, delta: m.macroF1 - 0.85, passed: m.macroF1 > 0.85 });
    results.push({ subsystem: "kyt-classifier", metric: "false-positive-rate", baseline: 0.05, current: m.falsePositiveRate, delta: m.falsePositiveRate - 0.05, passed: m.falsePositiveRate < 0.05 });
    results.push({ subsystem: "kyt-classifier", metric: "accuracy", baseline: 0.9, current: m.accuracy, delta: m.accuracy - 0.9, passed: m.accuracy >= 0.9 });
    console.log(
      `[kyt-classifier] wallets=${ds.wallets.length} macroF1=${m.macroF1.toFixed(3)} fpr=${m.falsePositiveRate.toFixed(3)} accuracy=${m.accuracy.toFixed(3)}`,
    );
  }

  const report: EvaluationReport = {
    generatedAt: new Date().toISOString(),
    synthetic: true,
    results,
  };
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(resolve(REPORT_DIR, "latest.json"), serializeReport(report), "utf8");

  const anyFailed = results.some((r) => !r.passed);
  console.log(anyFailed ? "\n\u2717 EVALUATION FAILED — see mismatches above" : "\n\u2713 EVALUATION PASSED");
  process.exit(anyFailed ? 1 : 0);
}

main();
