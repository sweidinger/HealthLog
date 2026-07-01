/**
 * @fileoverview ESLint rule — raw Tailwind palette color utilities are
 * banned in app UI; route every tone through a semantic token.
 *
 * v1.26.0 — the design-consistency wave collapsed the app's colour
 * vocabulary onto semantic tokens (`text-warning` / `text-info` /
 * `text-success` / `text-destructive` and their `bg-*` / `border-*` /
 * opacity forms, plus `stroke-[var(--warning)]` for SVG accents). A raw
 * `text-amber-500` / `bg-green-500` / `dark:text-red-400` re-introduces a
 * hard-coded Tailwind stock tone that drifts off the token system, breaks
 * light/dark parity, and often fails AA against the card surface. This
 * rule flags those utilities at authoring time and in CI so the tokenised
 * palette cannot regress.
 *
 * Match: a className fragment
 *   (text|bg|border|ring|stroke|fill|from|to|via)-<palette>-<step>
 * where <palette> is one of the Tailwind stock hues and <step> is a
 * numeric 50…950 shade. The `-<step>` suffix is what pins it to the raw
 * palette — bare `bg-white` / `text-black` (QR quiet-zone) and semantic
 * tokens (`text-warning`, `bg-success/10`) never carry a numeric shade and
 * so never match.
 *
 * Scope: `src/components/**` + `src/app/**`. The check inspects string
 * literals and template-literal chunks (covering `className="…"`,
 * `cn("…")`, cva variant maps, and `clsx` calls alike) — a syntactic
 * match, mirroring the queryKey-factory / safe-fetch-required rules.
 *
 * Exempt files (narrow, path-suffix matched):
 *   - `src/app/global-error.tsx` — the App-Router global error boundary
 *     renders WITHOUT the token stylesheet loaded, so a future edit there
 *     legitimately needs raw palette / inline colour.
 * Test files (`*.test.ts(x)`, `__tests__/`, `__mocks__/`) are exempt too.
 *
 * @see src/app/globals.css   — the semantic token definitions.
 */

"use strict";

// Files exempt from the rule. Posix-style suffix match against the
// absolute filename via `String#includes`, mirroring the sibling rules.
const EXEMPT_FILES = [
  // Runs without the token stylesheet — see the header note.
  "src/app/global-error.tsx",
];

// Only enforce inside the app UI roots.
const ENFORCED_ROOTS = ["src/components/", "src/app/"];

// Raw Tailwind palette utility: a color property prefix, a stock hue, and
// a numeric 50…950 shade. The `\b` bounds let a `dark:` / `hover:` / group
// modifier prefix and a `/10` opacity suffix ride along while still
// pinning the numeric shade that distinguishes raw palette from tokens.
const RAW_PALETTE_RE =
  /\b(?:text|bg|border|ring|stroke|fill|from|to|via)-(?:amber|sky|red|green|emerald|blue|orange|yellow|pink|purple|violet|zinc|gray|slate|neutral|stone|rose|lime|teal|cyan|indigo|fuchsia)-(?:50|100|200|300|400|500|600|700|800|900|950)\b/;

function toPosix(filename) {
  return filename.replace(/\\/g, "/");
}

function isTestFile(posix) {
  return (
    /\.test\.[cm]?[jt]sx?$/.test(posix) ||
    /\.spec\.[cm]?[jt]sx?$/.test(posix) ||
    posix.includes("/__tests__/") ||
    posix.includes("/__mocks__/")
  );
}

function isEnforced(filename) {
  const posix = toPosix(filename);
  if (!ENFORCED_ROOTS.some((root) => posix.includes(root))) return false;
  if (EXEMPT_FILES.some((f) => posix.includes(f))) return false;
  if (isTestFile(posix)) return false;
  return true;
}

/** @type {import("eslint").Rule.RuleModule} */
const noRawPaletteColorRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Ban raw Tailwind palette color utilities in app UI; route every tone through a semantic token (text-warning / text-info / text-success / text-destructive and their bg / border / opacity forms).",
    },
    schema: [],
    messages: {
      rawPalette:
        'Raw Tailwind palette utility "{{match}}" bypasses the semantic token system (drifts off the palette, breaks light/dark parity, often fails AA). Use a token: caution → text-warning / border-warning / bg-warning/10, info → text-info, success → text-success, destructive → text-destructive; SVG accents → stroke-[var(--warning)].',
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename?.();
    if (!filename || !isEnforced(filename)) {
      return {};
    }

    function checkText(node, text) {
      if (typeof text !== "string") return;
      const m = RAW_PALETTE_RE.exec(text);
      if (m) {
        context.report({
          node,
          messageId: "rawPalette",
          data: { match: m[0] },
        });
      }
    }

    return {
      Literal(node) {
        if (typeof node.value === "string") {
          checkText(node, node.value);
        }
      },
      TemplateElement(node) {
        checkText(node, node.value.cooked ?? node.value.raw);
      },
    };
  },
};

module.exports = noRawPaletteColorRule;
