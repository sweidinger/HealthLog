import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import healthlogPlugin from "./eslint-plugins/healthlog/index.js";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // v1.4.41 — ignore local tool worktrees so a worktree on an older
    // commit can't poison `pnpm lint` locally.
    // CI never sees this path; the rule is for the dev environment.
    ".claude/**",
    // The project-local ESLint rule plugin is CommonJS (require/module
    // .exports) by ESLint convention; it is not application source and
    // is not linted by the app's TypeScript ruleset.
    "eslint-plugins/**",
  ]),
  // v1.4.41 — custom rule that flags any bare-array
  // `queryKey: [ … ]` / `mutationKey: [ … ]` declaration inside the
  // files the queryKeys factory currently guards. Promotes the earlier
  // v1.4.40 test-guard substitute to a real ESLint rule so IDE + CI
  // both fail fast on a factory bypass. See
  // `eslint-plugins/healthlog/queryKey-factory.js` for the
  // whitelist + rationale.
  {
    plugins: { healthlog: healthlogPlugin },
    rules: {
      "healthlog/queryKey-factory": "error",
      // v1.5.6 — every outbound fetch under src/lib + src/app must route
      // through the safeFetch wrapper (manual-redirect + timeout, and the
      // requirePublicHost connect-time pin). The wrapper internals and
      // test files are exempt; see the rule file for the allowlist.
      "healthlog/safe-fetch-required": "error",
      // v1.16.4 — same-origin `/api/...` calls in the client surface
      // (src/components + src/app) must route through the typed apiFetch
      // wrapper (`src/lib/api/api-fetch.ts`): one `.ok` check, one
      // envelope unwrap, one ApiError shape. Wrapper internals and test
      // files are exempt; see the rule file for the allowlist.
      "healthlog/api-fetch-required": "error",
      // v1.26.0 — the design-consistency wave locked the app's colour
      // vocabulary onto semantic tokens. Raw Tailwind palette utilities
      // (`text-amber-500`, `bg-green-500`, `dark:text-red-400`, …) under
      // src/components + src/app are banned so the tokenised palette can't
      // regress. v1.27.x extends the rule with two further error-level
      // checks: colour-shaped JS props carrying a raw `#hex`/`rgb(`/`hsl(`/
      // `oklch(` literal (the Recharts `color`/`stroke`/`fill` blind spot),
      // and Tailwind arbitrary-value colours (`bg-[#…]`).
      // `src/app/global-error.tsx` (renders without the token stylesheet),
      // the `themeColor` viewport metadata, and test files are exempt; see
      // the rule file.
      "healthlog/no-raw-palette-color": [
        "error",
        { checks: ["palette", "color-props", "arbitrary-value"] },
      ],
      // The semantic sweep retired every raw `*-dracula-*` utility site
      // (status meaning → success/warning/info/destructive, purple →
      // primary, pink → the --brand-pink token), so the staged warning is
      // now a hard error. `var(--dracula-*)` references in chart code are
      // token references, not utilities, and stay legal — the light-theme
      // overrides in globals.css keep them AA on both themes.
      "healthlog/no-dracula-utility": ["error", { checks: ["dracula"] }],
      // Spacing-scale discipline. Two error-clean checks: pt-/pb- on
      // CardHeader/CardContent fights the gap-based Card contract (re-opens
      // the sl-001 drift class), and an off-scale `5` step (p-5/py-5/space-y-5/
      // gap-5) on a bg-card+border shell reads denser than every sibling
      // <Card>. The shell check is scoped to the bg-card+border pair so
      // justified list-marker insets (pl-5/pl-7) and form-body rhythm never
      // trip it. Density lives on the Card itself (`gap-2 py-3 md:py-4`) or on
      // a swept `p-4 md:p-6` shell. See the rule header.
      "healthlog/spacing-scale": "error",
    },
  },
]);

export default eslintConfig;
