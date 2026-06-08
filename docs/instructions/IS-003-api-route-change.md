# IS-003 — API Route Change

**PRE:** Load `kyc-api.mdc`, `ARCHITECTURE_CONTEXT` §7.

1. Add route handler in `src/api/routes/<domain>.ts`.
2. Export route group if new file; register in `src/api/index.ts`.
3. Middleware order matters: `src/api/index.ts:L21-L46` — onError → requestId → headers → cors → auth → rateLimit.
4. Apply `authMiddleware` + `rateLimit("api")` unless public route.
5. Validate input via `validateJson()` + Zod schema from `src/api/middleware/validate.ts`.
6. Return RFC 7807 errors via `problem()` from `src/api/middleware/error-handler.ts`.
7. PII: `encryptPii()` before DB write, return `*Mask` in list responses (INV-003).
8. Write audit log for state-changing operations via `writeAuditLog()`.
9. Check plan gates: webhooks/rescreen require growth+ (ADR-009).
10. Add integration test in `tests/integration/api/`.
11. Update `ARCHITECTURE_CONTEXT` §7 route table.
12. Run: `npm run typecheck && npm run test`.
13. Run IS-006 session exit.
