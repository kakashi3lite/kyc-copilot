# IS-006 — Session Exit (all roles)

1. Copy `docs/templates/SESSION_STATE.yaml` to project root as `.session-state.yaml`.
2. Fill every required field — no empty values for: role, instruction_set, task.summary, task.status.
3. List `files_touched` with one-line reason each.
4. List `invariants_checked` as pass/fail/n/a for INV-001..007.
5. Set `next_role` + `next_instruction_set` for continuation.
6. Set `context_to_load` from CONTEXT_INDEX matrix for next agent.
7. Record `verification.typecheck` and `verification.tests` if commands were run.
8. If ADR needed but not written: set `task.blocker: true` + `blocker_reason`.
9. Do NOT end session without this file.
