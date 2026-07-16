/**
 * @fileoverview ESLint rule — spacing-scale discipline. Two checks:
 *
 *  1. `slotPadding` — no `pt-*` / `pb-*` overrides on the gap-based Card
 *     slots. The Card primitive is gap-based, not padding-based
 *     (`src/components/ui/card.tsx`): the header→body distance comes from
 *     the PARENT flex gap, never from slot padding. A `pb-*` on
 *     `<CardHeader>` or a `pt-*` on `<CardContent>` therefore adds on top
 *     of the gap (or is a no-op) and inverts its own intent — the drift
 *     class the sl-001 sweep cleaned (~35 stale overrides). Density is
 *     expressed on the Card itself (`<Card className="gap-2 py-3 md:py-4">`,
 *     the sanctioned compact tier), never on a slot.
 *
 *     Detection: JSX elements named `CardHeader` / `CardContent` (any
 *     member-expression tail, so `UI.CardHeader` matches too) whose
 *     `className` carries a static `pt-<n>` / `pb-<n>` fragment — including
 *     modifier-prefixed (`md:pb-2`) and arbitrary-value (`pb-[10px]`) forms.
 *     Non-numeric suffixes (`pb-safe`) never match.
 *
 *  2. `cardShellStep5` — no off-scale `5` step (20 px, banned by §2) on a
 *     hand-rolled card SHELL. The shell heuristic (§7.2) keys off the
 *     `bg-card` + `border` pair on ONE element: a `p-5` / `px-5` / `py-5` /
 *     `space-y-5` / `gap-5` there sits denser than every sibling `<Card>`
 *     (which is `p-4 md:p-6`), and the 4 px step reads next to a conformant
 *     card on the same viewport. Deliberately NARROW: it fires only when the
 *     same element paints a card surface, so justified `pl-5`/`pl-7`
 *     list-marker insets (no `bg-card`) and form-body `space-y-5` rhythm (no
 *     shell) never trip it. Hand-rolled shells sweep to `p-4 md:p-6`
 *     (or `p-3` for a dense inner tile); new surfaces compose `<Card>`.
 *
 * Both checks collect strings from the whole `className` subtree, so
 * `cn("…", cond && "…")`, ternaries, and template literals are all seen.
 *
 * Scope: `src/components/**` + `src/app/**`; test files exempt — same
 * gating as the sibling rules. `src/components/ui/*` primitives compose the
 * shells themselves and are untouched by construction (they carry no
 * `bg-card` + `border` + step-5 combination).
 *
 * There is deliberately NO allowlist: no current site has a documented
 * load-bearing reason. If one ever appears it carries an inline
 * `eslint-disable-next-line` with the reason — visible in review — rather
 * than a silent registry entry here.
 *
 * @see .planning/audits/2026-07-05-fable/UI-STANDARDS.md §1 + §2 + §7.
 */

"use strict";

// Only enforce inside the app UI roots.
const ENFORCED_ROOTS = ["src/components/", "src/app/"];

// A pt-/pb- utility with a numeric step, `px`, or an arbitrary value,
// optionally behind modifier prefixes (`md:`, `hover:`, `[.border-b]:`).
// `pb-safe` (safe-area helpers) and word-suffixed utilities never match.
const SLOT_PADDING_RE =
  /(?:^|\s)(?:[^\s"']*:)*(p[tb]-(?:\d+(?:\.\d+)?|px|\[[^\]]+\]))(?=\s|$)/;

const SLOT_NAMES = new Set(["CardHeader", "CardContent"]);

// Card-shell heuristic: the element paints a card surface (`bg-card`) AND a
// border. `\bborder\b` matches `border`, `border-border`, `border-b`,
// `border-dashed` — any border utility qualifies as a shell.
const SHELL_BG_RE = /\bbg-card\b/;
const SHELL_BORDER_RE = /\bborder(?:-|\b)/;

// The banned `5` step (20 px) on a shell — the subset §7.2 scopes to an
// error-clean rule: p-5 / px-5 / py-5 / space-y-5 / gap-5, with optional
// modifier prefixes (`sm:p-5`). Directional insets (`pl-5`/`pr-5`) and
// half-steps are intentionally OUT of scope (see the header).
const SHELL_STEP5_RE =
  /(?:^|\s)(?:[^\s"']*:)*((?:p|px|py|space-y|gap)-5)(?=\s|$)/;

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
  if (isTestFile(posix)) return false;
  return true;
}

/** Resolve the rendered-element name (`CardHeader`, `UI.CardHeader` → tail). */
function elementName(openingElement) {
  const nameNode = openingElement.name;
  if (nameNode.type === "JSXIdentifier") return nameNode.name;
  if (
    nameNode.type === "JSXMemberExpression" &&
    nameNode.property.type === "JSXIdentifier"
  ) {
    return nameNode.property.name;
  }
  return null;
}

/**
 * Collect every static string reachable inside the className attribute
 * value: plain literals, template chunks, and the arguments of helper
 * calls (`cn(…)`, `clsx(…)`), conditionals and logical fallbacks.
 */
function collectStrings(node, out) {
  if (!node) return;
  switch (node.type) {
    case "Literal":
      if (typeof node.value === "string") out.push({ node, text: node.value });
      return;
    case "TemplateLiteral":
      for (const quasi of node.quasis) {
        out.push({ node: quasi, text: quasi.value.cooked ?? quasi.value.raw });
      }
      for (const expr of node.expressions) collectStrings(expr, out);
      return;
    case "CallExpression":
      for (const arg of node.arguments) collectStrings(arg, out);
      return;
    case "ConditionalExpression":
      collectStrings(node.consequent, out);
      collectStrings(node.alternate, out);
      return;
    case "LogicalExpression":
      collectStrings(node.left, out);
      collectStrings(node.right, out);
      return;
    case "ArrayExpression":
      for (const el of node.elements) collectStrings(el, out);
      return;
    case "JSXExpressionContainer":
      collectStrings(node.expression, out);
      return;
    default:
      return;
  }
}

/** @type {import("eslint").Rule.RuleModule} */
const spacingScaleRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Spacing-scale discipline — no pt-*/pb-* overrides on gap-based Card slots, and no off-scale `5` step on a bg-card+border shell.",
    },
    schema: [],
    messages: {
      slotPadding:
        '"{{match}}" on <{{element}}> fights the gap-based Card contract — the header→body distance comes from the parent flex gap, so slot padding stacks on top of it (or is a no-op). Tune density on the Card itself instead: <Card className="gap-2 py-3 md:py-4">.',
      cardShellStep5:
        'Off-scale "{{match}}" (20 px) on a bg-card+border shell — the `5` step is banned (UI-STANDARDS §2) and reads denser than every sibling <Card> (p-4 md:p-6). Sweep the shell to `p-4 md:p-6` (or `p-3` for a dense inner tile); new surfaces should compose <Card>.',
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename?.();
    if (!filename || !isEnforced(filename)) {
      return {};
    }

    return {
      JSXOpeningElement(node) {
        const classNameAttr = node.attributes.find(
          (attr) =>
            attr.type === "JSXAttribute" &&
            attr.name?.type === "JSXIdentifier" &&
            attr.name.name === "className",
        );
        if (!classNameAttr) return;

        const strings = [];
        collectStrings(classNameAttr.value, strings);

        // Check 1 — pt-/pb- slot padding on the gap-based Card slots.
        const name = elementName(node);
        if (name && SLOT_NAMES.has(name)) {
          for (const { node: strNode, text } of strings) {
            const m = SLOT_PADDING_RE.exec(text);
            if (m) {
              context.report({
                node: strNode,
                messageId: "slotPadding",
                data: { match: m[1], element: name },
              });
            }
          }
        }

        // Check 2 — off-scale `5` step on a card shell. Join every collected
        // string so the `bg-card` + `border` pair and the step-5 utility are
        // seen together even when split across cn() args, then report once.
        const joined = strings.map((s) => s.text).join(" ");
        if (SHELL_BG_RE.test(joined) && SHELL_BORDER_RE.test(joined)) {
          const m = SHELL_STEP5_RE.exec(joined);
          if (m) {
            context.report({
              node: classNameAttr,
              messageId: "cardShellStep5",
              data: { match: m[1] },
            });
          }
        }
      },
    };
  },
};

module.exports = spacingScaleRule;
