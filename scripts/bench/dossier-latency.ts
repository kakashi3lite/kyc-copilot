/**
 * Dossier-latency benchmark (Phase 5).
 *
 * Measures the end-to-end t0 graph pipeline — deterministic adapter +
 * t0 deterministic LLM, no network, no browser, in-memory graph stub —
 * across the 20-case cost-router golden dataset and reports p50/p95.
 *
 * Gate: p95 < 10 s. Writes tests/evaluation/reports/dossier-latency.json.
 * Usage: npm run bench:latency
 */

import { performance } from "node:perf_hooks";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { KycGraph } from "../../src/graph/graph.js";
import { DeterministicKycDataAdapter } from "../../src/services/kyc-data/deterministic.js";
import { DeterministicLlmClient } from "../../src/services/llm/client.js";
import { RouterGoldenSchema } from "../../tests/evaluation/harness.js";
import type { GraphContext, GraphQueryService } from "../../src/services/kyc-data/graph-query.js";
import type { ResolvedEntity } from "../../src/services/kyc-data/entity-resolver.js";

const P95_GATE_MS = 10_000;

/** In-memory graph-query stub — keeps the benchmark DB-free and deterministic. */
const graphStub: GraphQueryService = {
  getContext: async (_t: string, _c: string, entityName: string, _j: string): Promise<GraphContext> => ({
    relatedEntities: [],
    priorCases: [],
    entityResolution: { isNewEntity: true, canonicalName: entityName, confidence: 1, mergedFrom: 0 },
  }),
  upsertEntity: async (_r: ResolvedEntity): Promise<string> => "ent_bench",
  linkCaseToEntity: async (): Promise<void> => undefined,
};

const browserStub = {
  lookup: async () => ({ data: null, evidence: null, requiresHuman: false, reason: "bench-stub" }),
};

async function main(): Promise<void> {
  const raw = readFileSync(resolve(process.cwd(), "tests", "evaluation", "datasets", "cost-router-golden.json"), "utf8");
  const dataset = RouterGoldenSchema.parse(JSON.parse(raw));

  const graph = new KycGraph({
    adapter: new DeterministicKycDataAdapter(),
    browser: browserStub,
    llm: new DeterministicLlmClient(),
    graphQuery: graphStub,
  });

  // Warm-up run (JIT + module init) — not measured.
  await graph.run({ caseId: "bench_warm", tenantId: "ten_bench", companyName: "Warmup BV", registrationNumber: "BENCH-WARM", jurisdiction: "NL" });

  const times: number[] = [];
  for (const c of dataset.cases) {
    const start = performance.now();
    const state = await graph.run({
      caseId: `bench_${c.caseId}`,
      tenantId: "ten_bench",
      companyName: c.companyName,
      registrationNumber: `BENCH-${c.caseId.toUpperCase()}`,
      jurisdiction: c.jurisdiction,
    });
    times.push(performance.now() - start);
    if (state.status === "failed") console.warn(`  case ${c.caseId} produced status ${state.status}`);
  }

  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length * 0.5)] ?? 0;
  const p95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))] ?? 0;
  const avg = times.reduce((a, b) => a + b, 0) / times.length;

  const report = {
    generatedAt: new Date().toISOString(),
    cases: dataset.cases.length,
    p50Ms: Math.round(p50),
    p95Ms: Math.round(p95),
    avgMs: Math.round(avg),
    maxMs: Math.round(times[times.length - 1] ?? 0),
    gateP95Ms: P95_GATE_MS,
    passed: p95 < P95_GATE_MS,
  };

  mkdirSync(resolve(process.cwd(), "tests", "evaluation", "reports"), { recursive: true });
  writeFileSync(
    resolve(process.cwd(), "tests", "evaluation", "reports", "dossier-latency.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );

  console.log(`[latency] cases=${dataset.cases.length} p50=${Math.round(p50)}ms p95=${Math.round(p95)}ms avg=${Math.round(avg)}ms max=${Math.round(times[times.length - 1] ?? 0)}ms`);
  console.log(report.passed ? "✓ p95 under gate (10s)" : `✗ p95 exceeds gate (${P95_GATE_MS}ms)`);
  process.exit(report.passed ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
