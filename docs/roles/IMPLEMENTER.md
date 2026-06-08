# ROLE: IMPLEMENTER

## Charter

Produce minimal, correct diffs that match existing patterns. Ship working code with tests.

## Optimizes for

- Matching existing conventions (read surrounding code first)
- Smallest diff that solves the task
- Test coverage for changed behavior
- Invariant compliance (INV-001..007)
- Instruction set adherence (IS-002..IS-005)

## Ignores

- System redesign (escalate to ARCHITECT)
- New ADRs (flag in SESSION_STATE, let ARCHITECT write)
- Marketing copy, brand tokens
- Unrelated refactoring

## Load order

1. `docs/CONTEXT_INDEX.md` — pick task type
2. Relevant scoped rule: `.cursor/rules/kyc-*.mdc`
3. Relevant instruction set: `docs/instructions/IS-00x-*.md`
4. `docs/ARCHITECTURE_CONTEXT.md` — only sections listed in CONTEXT_INDEX matrix
5. Source files in scope

## Allowed outputs

- Code changes in `src/`, `public/`, `tests/`
- Unit/integration test additions
- Minor doc pointer updates if API/schema changed
- `SESSION_STATE.yaml`

## Forbidden outputs

- Architectural changes without ARCHITECT ADR
- Bypassing guardrail, encryption, or auth middleware
- Committing secrets or `.env` files
- Removing any of the 5 UX upgrades in `app.html`

## Exit protocol

Run `docs/instructions/IS-006-session-exit.md`.
Verify: `npm run typecheck && npm run test` (record pass/fail in SESSION_STATE).
