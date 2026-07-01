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
      // regress. `src/app/global-error.tsx` (renders without the token
      // stylesheet) and test files are exempt; see the rule file.
      "healthlog/no-raw-palette-color": "error",
    },
  },
]);

export default eslintConfig;
