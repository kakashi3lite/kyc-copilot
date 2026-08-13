---
repo: kyc-copilot
path: /Volumes/T9/GG/CurrentProjects/kyc-copilot
doc: EVALUATION_BASELINES
title: Evaluation Baselines — Golden Dataset Gates (Phase 2)
status: current
updated: 2026-08-13
related: [PLAN_PRODUCTION_READINESS.md §Phase 2, tests/evaluation/harness.ts, tests/evaluation/datasets/*.json]
---

# Evaluation Baselines

> Every model/classifier change must be benchmarked against these gates before
> merge. Measured on the committed golden datasets with the REAL production
> implementations (no LLM, no I/O). Re-run with `npm run bench:eval` or via
> `npm run test:eval`.

## Gates (measured 2026-08-13)

| Subsystem | Metric | Gate | Measured | Note |
|---|---|---|---|---|
| rag-graph | entity-resolution-f1 | > 0.90 | 1.000 | 25 pairs / 50 entities, 18 expected merges |
| rag-graph | entity-resolution-precision | = 1.00 | 1.000 | zero false positives |
| rag-graph | entity-resolution-recall | = 1.00 | 1.000 | zero false negatives |
| cost-router | tier-agreement | ≥ 0.85 | 1.000 | 20 golden cases vs classifier |
| cost-router | low-cost-tier-ratio | ≥ 0.60 | 0.800 | 16/20 cases on t0–t2 |
| cost-router | cache-hit-rate | ≥ 0.15 | 0.200 | 4/20 cacheable replays |
| cost-router | cost-per-dossier-usd | ≤ all-t4 baseline | 0.0024 vs 0.0291 | ~92% cheaper than all-t4 |
| kyt-classifier | macro-f1 | > 0.85 | 1.000 | 24 synthetic wallets (6/class) |
| kyt-classifier | false-positive-rate | < 0.05 | 0.000 | clean wallets stay clean |
| kyt-classifier | per-class recall | ≥ 0.85 | 1.000 | all four typologies |
| latency | dossier p95 (t0, in-memory) | < 10 s | < 1 ms | `bench:latency`; excludes LLM/network by design (deterministic path) |
| drift | golden snapshot vs baseline | no alerts | ✓ no drift | `bench:drift`; committed baseline `drift-baseline.json` |

## What "measured" means

- `entity-resolution-*`: `DeterministicEntityResolver` over
  `entity-resolution-golden.json` (threshold 0.70 from the dataset).
- `tier-agreement` / `low-cost-tier-ratio`: `DeterministicDifficultyClassifier`
  over `cost-router-golden.json` features.
- `cache-hit-rate`: offline `simulateCacheHits` — duplicate `replayKey`s among
  `cacheable` cases (no Redis in CI; the real router cache is exercised by the
  e2e suite against Redis).
- `cost-per-dossier-usd`: `PROVIDERS` catalog pricing at predicted tiers vs the
  same token volumes on t4 (worst case).

## Golden datasets are regression baselines

They record today's intended behavior (mirroring the classifier rules and the
resolver scoring). A change that requires updating a dataset is a deliberate
product decision and must be reviewed as such — not a silent test repair.

## Reproduction

```bash
npm run test:eval     # vitest gate (fails on any regression)
npm run bench:eval    # prints summary + writes tests/evaluation/reports/latest.json
```
