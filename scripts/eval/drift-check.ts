/**
 * Drift check (Phase 5). Compares the current golden-dataset snapshot to
 * the recorded baseline and alerts on regressions.
 *
 *   npm run bench:drift               # compare (exit 1 on drift)
 *   npm run bench:drift -- --record   # (re)record the baseline
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildDriftSnapshot, detectDrift, loadDriftBaseline } from "../../tests/evaluation/drift.js";

const BASELINE = resolve(process.cwd(), "tests", "evaluation", "drift-baseline.json");

function main(): void {
  const current = buildDriftSnapshot();

  if (process.argv.includes("--record")) {
    mkdirSync(resolve(process.cwd(), "tests", "evaluation"), { recursive: true });
    writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`, "utf8");
    console.log("Drift baseline recorded:");
    console.log(JSON.stringify(current, null, 2));
    process.exit(0);
  }

  const baseline = loadDriftBaseline();
  if (baseline === null) {
    console.log("No baseline found — run `npm run bench:drift -- --record` first.");
    process.exit(1);
  }

  const result = detectDrift(current, baseline);
  console.log(
    `[drift] agreement=${current.agreement.toFixed(3)} lowCostRatio=${current.lowCostRatio.toFixed(3)} entityF1=${current.entityResolutionF1.toFixed(3)} ` +
      `tiers=${JSON.stringify({ t0: current.t0, t1: current.t1, t2: current.t2, t3: current.t3, t4: current.t4 })}`,
  );
  if (result.alerts.length > 0) {
    for (const alert of result.alerts) console.log(`  DRIFT: ${alert}`);
    console.log("✗ DRIFT DETECTED");
    process.exit(1);
  }
  console.log("✓ no drift");
}

main();
