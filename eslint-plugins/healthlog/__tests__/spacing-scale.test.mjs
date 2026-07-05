/**
 * Unit tests for the `healthlog/spacing-scale` rule — pt-* / pb-* slot
 * padding on CardHeader/CardContent is banned (the Card is gap-based;
 * density lives on the Card itself). Covers modifier prefixes,
 * cn()/ternary/template collection, the safe-area non-match, and the
 * scope gating shared with the sibling rules.
 */

import { describe, it } from "vitest";
import { RuleTester } from "eslint";
import rule from "../spacing-scale.js";

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

ruleTester.run("spacing-scale", rule, {
  valid: [
    // Density on the Card itself is the sanctioned pattern.
    {
      code: '<Card className="gap-2 py-3 md:py-4"><CardContent>x</CardContent></Card>',
      filename: APP_FILE,
    },
    // Slots without className, or with unrelated classes, are fine.
    { code: "<CardHeader />", filename: APP_FILE },
    {
      code: '<CardContent className="px-0 space-y-4" />',
      filename: APP_FILE,
    },
    // Other paddings on slots are not this rule's business.
    {
      code: '<CardContent className="pl-2 pr-2" />',
      filename: APP_FILE,
    },
    // Safe-area helpers are not scale steps and never match.
    {
      code: '<CardContent className="pb-safe" />',
      filename: APP_FILE,
    },
    // pt-/pb- on arbitrary elements stays legal — the contract is about
    // the gap-based Card slots only.
    { code: '<div className="pb-2" />', filename: APP_FILE },
    // Outside the enforced roots nothing matches.
    {
      code: '<CardHeader className="pb-2" />',
      filename: "/repo/scripts/tool.tsx",
    },
    // Test files are exempt.
    {
      code: '<CardHeader className="pb-2" />',
      filename: "/repo/src/components/__tests__/example.test.tsx",
    },
  ],
  invalid: [
    {
      code: '<CardHeader className="pb-2" />',
      filename: APP_FILE,
      errors: [{ messageId: "slotPadding" }],
    },
    {
      code: '<CardContent className="pt-0" />',
      filename: APP_FILE,
      errors: [{ messageId: "slotPadding" }],
    },
    // Modifier-prefixed and fractional steps.
    {
      code: '<CardHeader className="md:pb-1.5" />',
      filename: APP_FILE,
      errors: [{ messageId: "slotPadding" }],
    },
    // Arbitrary-value padding.
    {
      code: '<CardContent className="pt-[10px]" />',
      filename: APP_FILE,
      errors: [{ messageId: "slotPadding" }],
    },
    // Collected through cn() args…
    {
      code: '<CardHeader className={cn("pb-3", extra)} />',
      filename: APP_FILE,
      errors: [{ messageId: "slotPadding" }],
    },
    // …ternaries…
    {
      code: '<CardContent className={dense ? "pt-2" : "pt-4"} />',
      filename: APP_FILE,
      errors: [{ messageId: "slotPadding" }, { messageId: "slotPadding" }],
    },
    // …and template literals.
    {
      code: "<CardHeader className={`pb-2 ${extra}`} />",
      filename: APP_FILE,
      errors: [{ messageId: "slotPadding" }],
    },
    // Member-expression component tails match too.
    {
      code: '<UI.CardHeader className="pb-2" />',
      filename: APP_FILE,
      errors: [{ messageId: "slotPadding" }],
    },
  ],
});
