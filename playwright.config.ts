import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright configuration for the HealthLog E2E suite.
 *
 * The suite covers the smoke-level user paths (auth redirect, login
 * form, public version endpoint, locale switch, axe-core) without
 * needing seeded data — every spec either runs against an unauthed
 * surface or uses route interception to stub out the API. Specs that
 * need a logged-in user are kept narrow and flagged in their describe
 * block; CI runs them against a worker that seeds a deterministic test
 * user on startup.
 *
 * To run locally: `pnpm dlx playwright install --with-deps chromium`
 * once, then `pnpm e2e`.
 */
export default defineConfig({
  testDir: "./e2e",
  testIgnore: ["setup/**"],
  globalSetup: "./e2e/setup/global-setup.ts",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],

  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    // v1.18.6 — block the service worker in the test context. The
    // production build registers `/sw.js`, whose v1.18.6 data branch
    // serves allowlisted `/api/*` GET reads network-first. A worker-
    // originated `fetch` is NOT subject to Playwright's `page.route`
    // interception, so the SW would re-fetch the real (empty) backend
    // and serve that — bypassing every per-spec `route.fulfill` mock and
    // breaking read-after-write assertions (a just-created row never
    // surfaced). Blocking the worker keeps the route mocks authoritative
    // without weakening the shipped SW behaviour. Real users keep the
    // offline data cache; only the test harness opts out.
    serviceWorkers: "block",
    // HealthLog ships dark mode as the default (Dracula theme) — `globals.css`
    // sets `color-scheme: dark` on the root and the `<ThemeProvider>` defaults
    // to "system". Playwright's stock context is `colorScheme: "light"`, which
    // means axe-core was scanning a layout users never actually see (Dracula
    // greens on a light card → 1.18 contrast). Forcing the test theme to dark
    // matches what real users render on first paint and is the only honest
    // a11y baseline for this app.
    colorScheme: "dark",
  },

  projects: [
    {
      name: "chromium-desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 720 },
        colorScheme: "dark",
      },
    },
    {
      name: "chromium-mobile",
      use: {
        // Pixel 5 — Chromium-based mobile profile so CI only needs
        // `playwright install chromium` instead of also pulling
        // webkit. iPhone-13 is intentionally avoided here; the
        // mobile-Safari smoke is exercised by the iOS app suite.
        ...devices["Pixel 5"],
        colorScheme: "dark",
      },
    },
  ],

  // Spin up the production build for E2E. `pnpm build` is run
  // separately by CI before the suite — locally, set E2E_SKIP_WEB_SERVER=1
  // to point at an already-running dev server.
  webServer: process.env.E2E_SKIP_WEB_SERVER
    ? undefined
    : {
        command: "pnpm exec next start --port 3000",
        url: "http://localhost:3000/api/version",
        timeout: 60_000,
        reuseExistingServer: !process.env.CI,
        stdout: "ignore",
        stderr: "pipe",
      },
});
