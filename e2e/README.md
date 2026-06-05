# `e2e/`

End-to-end browser tests. Playwright 1.60 drives a production build of the app against a real PostgreSQL, with `@axe-core/playwright` for accessibility assertions. This is the heaviest test tier; CI runs it on every PR, and locally it is worth running when a change touches a UI flow.

## Running

```bash
pnpm e2e
```

The Playwright config (`../playwright.config.ts`) builds the app (`next build`) and brings up Postgres before the specs run; `setup/global-setup.ts` seeds the auth + fixture state. The suite is not part of the fast local gate (`typecheck` / `lint` / `test`) — it surfaces at PR CI, so expect responsive/wizard/nav reworks to flag here first.

## Layout

- **`setup/`** — `global-setup.ts` (auth + DB seeding), `test-helpers.ts` (shared login + navigation helpers).
- **`utils/`** — fixtures such as `mock-dashboard-snapshot.ts`.
- **`*.spec.ts`** — one spec per flow: auth/login/redirect, dashboard, charts, the medication-wizard cadences (`medications-wizard-*`), insights generation + scroll restoration, doctor report, settings, mobile-viewport consistency, locale switch, accessibility (`a11y.spec.ts`), and the `v1427-*` regression set.

## Convention

Assert against stable `data-*` attributes (`data-slot`, `data-display-step`, root display attrs), not viewport-dependent visible text. Responsive `sm:hidden` UI changes break `getByText` on desktop while the underlying element is still present — anchoring on data attributes keeps the specs stable across breakpoints. See [`../CLAUDE.md`](../CLAUDE.md).
