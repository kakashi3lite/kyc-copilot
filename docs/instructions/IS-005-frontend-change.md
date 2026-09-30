# IS-005 — Frontend Change

**PRE:** Load `kyc-frontend.mdc`, `ARCHITECTURE_CONTEXT` §11.

1. `public/landing.html` = marketing only. `public/app.html` = dashboard only.
2. No external JS/CSS dependencies — pure vanilla.
3. Brand tokens: canonical source `design-system/tokens/tokens.css` (cinematic dark theme, electric blue trust, emerald approvals; served at `/design-system/tokens.css`).
4. Preserve all 5 UX upgrades in `app.html`:
   - A: Toast notifications (`showToast`)
   - B: Skeleton loaders (`showSkeletons`)
   - C: Case completion ceremony (`showCeremony`)
   - D: Animated view transitions
   - E: Rich empty states
5. Routes served from `src/api/index.ts` — `GET /` and `GET /app` must not break.
6. Demo mode in `app.html` works without API key for UI preview.
7. Design-system changes: run the four gates — all must be green (CI enforces on GitHub Actions + GitLab CI):
   - `npm run token-lint` — 0 violations (no raw values, no undeclared tokens)
   - `node design-system/tokens/contrast-check.mjs` — WCAG AA must-pass pairs
   - `npm run registry-check` — tokens/components/usage all registered
   - `npm run ds-vr` — 4/4 visual baselines
8. Run IS-006 session exit.
