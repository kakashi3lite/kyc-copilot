# IS-005 — Frontend Change

**PRE:** Load `kyc-frontend.mdc`, `ARCHITECTURE_CONTEXT` §11.

1. `public/landing.html` = marketing only. `public/app.html` = dashboard only.
2. No external JS/CSS dependencies — pure vanilla.
3. Brand tokens: cinematic dark theme, electric blue trust, emerald approvals.
4. Preserve all 5 UX upgrades in `app.html`:
   - A: Toast notifications (`showToast`)
   - B: Skeleton loaders (`showSkeletons`)
   - C: Case completion ceremony (`showCeremony`)
   - D: Animated view transitions
   - E: Rich empty states
5. Routes served from `src/api/index.ts` — `GET /` and `GET /app` must not break.
6. Demo mode in `app.html` works without API key for UI preview.
7. Run IS-006 session exit.
