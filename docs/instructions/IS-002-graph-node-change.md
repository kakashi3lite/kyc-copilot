# IS-002 — Graph Node Change

**PRE:** Load `kyc-graph.mdc`, `ARCHITECTURE_CONTEXT` §5, `src/graph/edges.ts`.

1. Identify affected node in `src/graph/nodes/`.
2. Check INV-001, INV-002, INV-007 — list which apply.
3. Check DECISIONS ADR-001, ADR-002 — do not violate.
4. If adding node: update `KycGraph.run()` in `src/graph/graph.ts`.
5. If changing routing: update `src/graph/edges.ts`.
6. If changing state shape: update `src/graph/state.ts` + `src/graph/schemas.ts`.
7. Update `src/workers/graph-runner.ts` if persistence logic changes.
8. Add/update unit test in `tests/unit/nodes/`.
9. Run: `npm run typecheck && npm run test:unit`.
10. If architectural change needed: draft ADR in `docs/DECISIONS.md` before merge.
11. Update `ARCHITECTURE_CONTEXT` §5 if node order or routing changed.
12. Run IS-006 session exit.
