import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { KytGoldenSchema, kytMetrics } from "./harness.js";
import { generateWalletTransactions } from "../fixtures/transactions-synthetic.js";
import { extractFeatures } from "../../src/services/kyt/features.js";
import { classify } from "../../src/services/kyt/typology.js";
import type { KytProfileName } from "../../src/types/kyt.js";

const DATASETS = resolve(process.cwd(), "tests", "evaluation", "datasets");

const CLASSES = ["cybercrime_dispersion", "sanctions_evasion", "mixing", "clean"] as const;

function loadKytGolden() {
  const raw = readFileSync(resolve(DATASETS, "kyt-golden.json"), "utf8");
  return KytGoldenSchema.parse(JSON.parse(raw));
}

function runGoldenPredictions() {
  const ds = loadKytGolden();
  const predictions = ds.wallets.map((w) => {
    const verdict = classify(extractFeatures(generateWalletTransactions(w.profile as KytProfileName, w.seed)));
    return { walletId: w.walletId, predicted: verdict.typology };
  });
  const goldens = ds.wallets.map((w) => ({ walletId: w.walletId, expected: w.expectedTypology }));
  return { ds, metrics: kytMetrics(predictions, goldens), predictions };
}

describe("KYT golden gate — deterministic typology classifier, no LLM", () => {
  it("dataset is synthetic with ≥ 6 wallets per class", () => {
    const ds = loadKytGolden();
    expect(ds.synthetic).toBe(true);
    const counts: Record<string, number> = {};
    for (const w of ds.wallets) counts[w.expectedTypology] = (counts[w.expectedTypology] ?? 0) + 1;
    for (const cls of CLASSES) expect(counts[cls]).toBeGreaterThanOrEqual(6);
  });

  it("macro-F1 > 0.85 on the synthetic golden set", () => {
    const { metrics } = runGoldenPredictions();
    expect(metrics.macroF1).toBeGreaterThan(0.85);
  });

  it("false-positive rate < 5% (clean wallets must stay clean)", () => {
    const { metrics } = runGoldenPredictions();
    expect(metrics.falsePositiveRate).toBeLessThan(0.05);
  });

  it("per-class recall ≥ 0.85 for every typology", () => {
    const { metrics } = runGoldenPredictions();
    for (const cls of CLASSES) {
      expect(metrics.perClass[cls]!.recall, `recall ${cls}`).toBeGreaterThanOrEqual(0.85);
    }
  });
});
