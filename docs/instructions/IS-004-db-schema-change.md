# IS-004 — DB Schema Change

**PRE:** Load `ARCHITECTURE_CONTEXT` §6, `src/db/schema.ts`.

1. Edit `src/db/schema.ts`.
2. Run `npm run db:generate` to create migration.
3. Review generated SQL in `src/db/migrations/`.
4. Update `src/db/seed.ts` if seed data affected.
5. PII columns: always pair `*Encrypted` + `*Mask` (INV-003, ADR-003).
6. Add indexes for tenant-scoped queries.
7. Update Drizzle types if new tables affect `src/types/index.ts`.
8. Run: `npm run typecheck && npm run test`.
9. Update `ARCHITECTURE_CONTEXT` §6 table list + §9 file map.
10. Run IS-006 session exit.
