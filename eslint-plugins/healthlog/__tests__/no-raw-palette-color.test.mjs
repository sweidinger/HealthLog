/**
 * Unit tests for the `healthlog/no-raw-palette-color` rule — the four
 * detectors (`palette`, `dracula`, `color-props`, `arbitrary-value`), the
 * `checks` option that lets the flat config run them at split severities,
 * and the documented exemptions (global-error.tsx, themeColor metadata,
 * test files, `var(--token)` values).
 *
 * RuleTester needs a filename inside the enforced roots
 * (`src/components/` / `src/app/`) — the rule is scope-gated.
 */

import { describe, it } from "vitest";
import { RuleTester } from "eslint";
import rule from "../no-raw-palette-color.js";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2023,
    sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

const APP_FILE = "/repo/src/components/insights/example.tsx";

ruleTester.run("no-raw-palette-color (default checks)", rule, {
  valid: [
    // Semantic tokens never carry a numeric shade.
    {
      code: 'const c = "text-warning bg-success/10 border-info";',
      filename: APP_FILE,
    },
    // QR quiet-zone style bare white/black stays legal.
    { code: 'const c = "bg-white text-black";', filename: APP_FILE },
    // var(--token) is the sanctioned chart-colour carrier.
    { code: '<Chart color="var(--success)" />', filename: APP_FILE },
    { code: 'const cfg = { stroke: "var(--chart-1)" };', filename: APP_FILE },
    // Arbitrary values referencing a token are fine.
    { code: 'const c = "stroke-[var(--warning)]";', filename: APP_FILE },
    // Non-colour props carrying a hash are not colour literals.
    { code: '<a href="#section" />', filename: APP_FILE },
    // themeColor viewport metadata is exempt by ancestry.
    {
      code: 'export const viewport = { themeColor: [{ media: "(prefers-color-scheme: dark)", color: "#282a36" }] };',
      filename: "/repo/src/app/layout.tsx",
    },
    // Dracula utilities do NOT error under the default check set — they
    // ride the separate warn-level registration.
    { code: 'const c = "text-dracula-green";', filename: APP_FILE },
    // Outside the enforced roots nothing matches.
    { code: 'const c = "text-amber-500";', filename: "/repo/src/lib/x.ts" },
    // The global error boundary renders without the token stylesheet.
    {
      code: 'const c = "text-amber-500";',
      filename: "/repo/src/app/global-error.tsx",
    },
    // Test files are exempt.
    {
      code: 'const c = "text-amber-500";',
      filename: "/repo/src/components/__tests__/example.test.tsx",
    },
  ],
  invalid: [
    // (original) raw Tailwind stock palette utility.
    {
      code: 'const c = "text-amber-500";',
      filename: APP_FILE,
      errors: [{ messageId: "rawPalette" }],
    },
    {
      code: "const c = `bg-green-500/10 ${extra}`;",
      filename: APP_FILE,
      errors: [{ messageId: "rawPalette" }],
    },
    // (b) colour-shaped JSX prop with a raw hex.
    {
      code: '<Chart color="#22c55e" />',
      filename: APP_FILE,
      errors: [{ messageId: "colorProp" }],
    },
    {
      code: '<path stroke="rgb(34, 197, 94)" />',
      filename: APP_FILE,
      errors: [{ messageId: "colorProp" }],
    },
    // (b) colour-shaped object property (Recharts config / style objects).
    {
      code: 'const cfg = { fill: "#8b5cf6" };',
      filename: APP_FILE,
      errors: [{ messageId: "colorProp" }],
    },
    {
      code: '<div style={{ backgroundColor: "oklch(0.5 0.1 300)" }} />',
      filename: APP_FILE,
      errors: [{ messageId: "colorProp" }],
    },
    // (b) hex embedded in a longer value (gradient) still trips.
    {
      code: '<div style={{ background: "linear-gradient(90deg, #ff5555, #bd93f9)" }} />',
      filename: APP_FILE,
      errors: [{ messageId: "colorProp" }],
    },
    // (c) Tailwind arbitrary colour values.
    {
      code: 'const c = "bg-[#282a36]";',
      filename: APP_FILE,
      errors: [{ messageId: "arbitraryColor" }],
    },
    {
      code: 'const c = "text-[oklch(0.7_0.1_300)]";',
      filename: APP_FILE,
      errors: [{ messageId: "arbitraryColor" }],
    },
    {
      code: 'const c = "border-[rgb(40,42,54)]";',
      filename: APP_FILE,
      errors: [{ messageId: "arbitraryColor" }],
    },
  ],
});

ruleTester.run("no-raw-palette-color (dracula check)", rule, {
  valid: [
    // Semantic + token forms stay clean under the dracula-only check set.
    {
      code: 'const c = "text-success bg-warning/10 text-amber-500";',
      filename: APP_FILE,
      options: [{ checks: ["dracula"] }],
    },
    // dracula var() references in CSS-in-JS strings are not utilities.
    {
      code: 'const c = "stroke-[var(--dracula-purple)]";',
      filename: APP_FILE,
      options: [{ checks: ["dracula"] }],
    },
  ],
  invalid: [
    {
      code: 'const c = "text-dracula-green";',
      filename: APP_FILE,
      options: [{ checks: ["dracula"] }],
      errors: [{ messageId: "draculaUtility" }],
    },
    {
      code: 'const c = "bg-dracula-orange/15 border-dracula-purple";',
      filename: APP_FILE,
      options: [{ checks: ["dracula"] }],
      errors: [{ messageId: "draculaUtility" }],
    },
    {
      code: 'const c = cn(isUp ? "text-dracula-cyan" : "text-muted-foreground");',
      filename: APP_FILE,
      options: [{ checks: ["dracula"] }],
      errors: [{ messageId: "draculaUtility" }],
    },
  ],
});
