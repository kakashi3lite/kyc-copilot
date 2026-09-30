# KYC Copilot Global AI Instructions

This global contract applies to every AI chat request and PR generation in the `kyc-copilot` repository.

## 1. Repository Context
- `public/` contains vanilla HTML surfaces (e.g., `app.html`, `landing.html`).
- `design-system/` contains the UI architecture: canonical tokens (`tokens/tokens.css`, served at `/design-system/tokens.css`), CSS component classes (`css/`), the component registry (`registry.json`), and browser-ready Lit components (`components/*.js`, preview at `/design-system/components.html`); Lit arrives via a vendored ESM import map — no build step (ADR-025).

## 2. Token Discipline
- Zero tolerance for raw hex colors or hardcoded `px` / `rem` values outside of `design-system/tokens/tokens.css`.
- Every visual property must reference a CSS custom property (token).

## 3. Component Registry Enforcement
- All UI elements must use the established components from the registry.
- Do not invent ad-hoc inline styles or bespoke CSS classes in the HTML surfaces.

## 4. Status Color Semantics (Inviolable)
- **Verified**: Emerald
- **Pending**: Orange
- **Blocked**: Red
- **Neutral**: Slate

## 5. Required Interactive States
Every interactive component (button, input, link, tab) MUST explicitly account for the following 8 states:
1. `default`
2. `hover`
3. `focus`
4. `active`
5. `disabled`
6. `loading`
7. `selected`
8. `error`

## 6. Verification Gates
Every design system change must pass:
- **Contrast checks**: WCAG AA minimum for text (`node design-system/tokens/contrast-check.mjs`).
- **Token-linting**: `npm run token-lint` passes — no raw values, no undeclared tokens (CI-enforced).
- **Visual regression**: `npm run ds-vr` (design-system baselines) and ensure `app.html` UX upgrades do not break.

## 7. Demo Ground Truth
Business logic semantics are fixed for the zero-key demo:
- **Acme Logistics BV** → `completed`
- **Volkov Capital Partners** → `pending_hitl`
