# CONTEXT_INDEX — KYC Copilot Context Router

> TL;DR: Read this file first. Pick your task type, adopt the role, run the instruction set, load only the listed files.

## Session start (mandatory)

1. Read this file.
2. Adopt role from matrix below → `docs/roles/<ROLE>.md`
3. Run instruction set → `docs/instructions/IS-xxx-*.md`
4. Load only files in the **Load** column — never the full repo.
5. On exit: run **IS-006** → write `.session-state.yaml` from `docs/templates/SESSION_STATE.yaml`

## Task → Load Matrix

| Task type | Role | IS | Load (in order) | ~Tokens |
|---|---|---|---|---|
| New cross-cutting feature | ARCHITECT | IS-001 | CONTEXT_INDEX → ARCHITECTURE_CONTEXT §1-3,9 → DECISIONS → roles/ARCHITECT | 2.5k |
| Graph / pipeline change | IMPLEMENTER | IS-002 | kyc-graph.mdc → ARCHITECTURE_CONTEXT §5 → `src/graph/graph.ts` → affected node | 1.5k |
| API route change | IMPLEMENTER | IS-003 | kyc-api.mdc → ARCHITECTURE_CONTEXT §7 → `src/api/routes/*.ts` | 1.2k |
| DB / schema change | IMPLEMENTER | IS-004 | ARCHITECTURE_CONTEXT §6 → `src/db/schema.ts` → migrations | 1k |
| Frontend / UX change | IMPLEMENTER | IS-005 | kyc-frontend.mdc → ARCHITECTURE_CONTEXT §11 → `public/*.html` | 800 |
| Compliance / audit review | COMPLIANCE_OFFICER | IS-001 | kyc-compliance.mdc → INV-001..007 → DECISIONS ADR-002,005,007 | 1.5k |
| Code review / PR | REVIEWER | IS-001 | DECISIONS → invariants → changed files only | 1k |
| Update context docs | CONTEXT_WRITER | IS-006 | All `docs/` → diff against codebase | 3k |
| Session end (any role) | current | IS-006 | Write `.session-state.yaml` | 300 |

## Anti-patterns

- Do NOT paste conversation history into new sessions.
- Do NOT load README if ARCHITECTURE_CONTEXT §2 covers the contract.
- Do NOT read all of `src/` — use file map in ARCHITECTURE_CONTEXT §9.
- Do NOT re-explain invariants in chat — cite `INV-00x`.
- Do NOT end a session without `.session-state.yaml`.

## Quick pointers

| Need | Go to |
|---|---|
| System map | `docs/ARCHITECTURE_CONTEXT.md` §3 |
| Graph pipeline | `docs/ARCHITECTURE_CONTEXT.md` §5 |
| API routes | `docs/ARCHITECTURE_CONTEXT.md` §7 |
| DB tables | `docs/ARCHITECTURE_CONTEXT.md` §6 |
| Why a choice was made | `docs/DECISIONS.md` |
| Last session state | `.session-state.yaml` (project root, gitignored) |
| Cursor rules | `.cursor/rules/kyc-*.mdc` |

## Repo

- Path: `/Users/kakashi3lite/kyc-copilot`
- Remote: `github.com/kakashi3lite/kyc-copilot`
- Version: 1.0.0
- Verify: `npm run typecheck && npm run test`
