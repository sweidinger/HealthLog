/**
 * @fileoverview ESLint rule — raw colour literals are banned in app UI;
 * route every tone through a semantic token.
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
 * v1.27.x — the rule grows three checks that closed known bypasses:
 *
 *   - `palette` (error) — the original check: a className fragment
 *     `(text|bg|border|ring|stroke|fill|from|to|via)-<stock-hue>-<step>`
 *     with a numeric 50…950 shade. Bare `bg-white` / `text-black` (QR
 *     quiet-zone) and semantic tokens never carry a numeric shade and so
 *     never match.
 *   - `color-props` (error) — colour-shaped JS props / object keys
 *     (`color` / `fill` / `stroke` / `background*`) receiving a string
 *     that contains a `#hex` / `rgb(` / `hsl(` / `oklch(` literal, e.g.
 *     `color="#22c55e"` or a Recharts `stroke`. Chart colours are passed
 *     as `var(--token)` strings instead. The `themeColor` viewport
 *     metadata is exempt (the PWA chrome colour is read by the browser
 *     before any stylesheet loads, so it must stay a literal).
 *   - `arbitrary-value` (error) — Tailwind arbitrary colour values
 *     (`bg-[#…]`, `text-[oklch(…)]`). `…-[var(--token)]` never matches.
 *   - `dracula` (WARN, staged) — raw `*-dracula-*` utilities. ~250
 *     legacy sites predate the token system; the light-theme overrides in
 *     `globals.css` defuse their AA failures, so the check ships as a
 *     warning first (registered separately as
 *     `healthlog/no-dracula-utility`). It moves to error once the
 *     semantic sweep (status meaning → `text-success/warning/info/
 *     destructive`, brand use → `--brand-*` tokens) has retired the
 *     legacy sites.
 *
 * The `checks` option selects which detectors run, so the flat config can
 * register the same module twice at different severities (see
 * `eslint-plugins/healthlog/index.js` + `eslint.config.mjs`).
 *
 * Scope: `src/components/**` + `src/app/**`. The string checks inspect
 * string literals and template-literal chunks (covering `className="…"`,
 * `cn("…")`, cva variant maps, and `clsx` calls alike) — a syntactic
 * match, mirroring the queryKey-factory / safe-fetch-required rules. The
 * `color-props` check additionally inspects JSX attributes and object
 * properties so it can key off the prop NAME.
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

// Raw `dracula-*` utility: the pre-token palette accessed directly
// (`text-dracula-green`, `bg-dracula-orange/15`). Same prefix set and
// modifier tolerance as the palette check.
const DRACULA_RE =
  /\b(?:text|bg|border|ring|stroke|fill|from|to|via)-dracula-[a-z]+\b/;

// Tailwind arbitrary colour value: `bg-[#…]`, `text-[rgb(…)]`,
// `border-[oklch(…)]`. Matching on the bracket-open plus a colour-literal
// head keeps `…-[var(--token)]` (the sanctioned escape hatch) clean.
const ARBITRARY_COLOR_RE = /-\[(?:#|rgba?\(|hsla?\(|oklch\()/;

// Colour-shaped prop / object-key names for the `color-props` check.
// Anchored so `themeColor` / `colorScheme` etc. never match.
const COLOR_PROP_NAME_RE = /^(?:color|fill|stroke|background[A-Za-z]*)$/;

// A colour literal inside a string value: hex, rgb()/rgba(), hsl()/hsla(),
// oklch(). `var(--token)` strings never match.
const COLOR_LITERAL_RE = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/;

const DEFAULT_CHECKS = ["palette", "color-props", "arbitrary-value"];

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

/**
 * The `themeColor` viewport metadata carries per-scheme colour literals
 * (`{ media, color }` entries) that the browser reads before any
 * stylesheet exists — the one sanctioned inline-colour site. Walk the
 * ancestor chain for a `themeColor` property so those entries stay exempt
 * without exempting the whole layout file.
 */
function isInsideThemeColor(node) {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (
      cur.type === "Property" &&
      !cur.computed &&
      ((cur.key.type === "Identifier" && cur.key.name === "themeColor") ||
        (cur.key.type === "Literal" && cur.key.value === "themeColor"))
    ) {
      return true;
    }
  }
  return false;
}

/** Extract the static string content of a Literal / TemplateLiteral value. */
function staticString(node) {
  if (!node) return null;
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node.type === "TemplateLiteral") {
    return node.quasis.map((q) => q.value.cooked ?? q.value.raw).join(" ");
  }
  return null;
}

/** @type {import("eslint").Rule.RuleModule} */
const noRawPaletteColorRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Ban raw colour literals in app UI — Tailwind stock palette utilities, raw dracula-* utilities, hex/rgb/hsl/oklch in colour-shaped JS props, and arbitrary-value colours; route every tone through a semantic token.",
    },
    schema: [
      {
        type: "object",
        properties: {
          checks: {
            type: "array",
            items: {
              enum: ["palette", "dracula", "color-props", "arbitrary-value"],
            },
            uniqueItems: true,
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      rawPalette:
        'Raw Tailwind palette utility "{{match}}" bypasses the semantic token system (drifts off the palette, breaks light/dark parity, often fails AA). Use a token: caution → text-warning / border-warning / bg-warning/10, info → text-info, success → text-success, destructive → text-destructive; SVG accents → stroke-[var(--warning)].',
      draculaUtility:
        'Raw dracula utility "{{match}}" reads the pre-token palette directly. Status meaning → text-success / text-warning / text-info / text-destructive (and their bg/border forms); brand identity → a named --brand-* token. Legacy sites survive on the light-theme overrides in globals.css; do not add new ones.',
      colorProp:
        'Colour-shaped prop "{{name}}" receives the raw colour literal "{{value}}". Pass a theme token instead — color="var(--success)" / stroke="var(--chart-1)" — so both themes and future token retunes apply.',
      arbitraryColor:
        'Arbitrary-value colour utility "{{match}}" hard-codes a tone outside the token system. Use a semantic utility (text-warning, bg-success/10) or a token reference (…-[var(--token)]).',
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename?.();
    if (!filename || !isEnforced(filename)) {
      return {};
    }

    const options = context.options?.[0] ?? {};
    const checks = new Set(options.checks ?? DEFAULT_CHECKS);

    function checkText(node, text) {
      if (typeof text !== "string") return;
      if (checks.has("palette")) {
        const m = RAW_PALETTE_RE.exec(text);
        if (m) {
          context.report({
            node,
            messageId: "rawPalette",
            data: { match: m[0] },
          });
        }
      }
      if (checks.has("dracula")) {
        const m = DRACULA_RE.exec(text);
        if (m) {
          context.report({
            node,
            messageId: "draculaUtility",
            data: { match: m[0] },
          });
        }
      }
      if (checks.has("arbitrary-value")) {
        const m = ARBITRARY_COLOR_RE.exec(text);
        if (m) {
          context.report({
            node,
            messageId: "arbitraryColor",
            data: { match: m[0] },
          });
        }
      }
    }

    function checkColorProp(node, name, valueNode) {
      if (!checks.has("color-props")) return;
      if (!COLOR_PROP_NAME_RE.test(name)) return;
      const value = staticString(valueNode);
      if (value === null) return;
      const m = COLOR_LITERAL_RE.exec(value);
      if (!m) return;
      if (isInsideThemeColor(node)) return;
      context.report({
        node,
        messageId: "colorProp",
        data: { name, value: m[0] },
      });
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
      JSXAttribute(node) {
        if (node.name?.type !== "JSXIdentifier") return;
        const valueNode =
          node.value?.type === "JSXExpressionContainer"
            ? node.value.expression
            : node.value;
        checkColorProp(node, node.name.name, valueNode);
      },
      Property(node) {
        if (node.computed) return;
        const name =
          node.key.type === "Identifier"
            ? node.key.name
            : node.key.type === "Literal" && typeof node.key.value === "string"
              ? node.key.value
              : null;
        if (!name) return;
        checkColorProp(node, name, node.value);
      },
    };
  },
};

module.exports = noRawPaletteColorRule;
