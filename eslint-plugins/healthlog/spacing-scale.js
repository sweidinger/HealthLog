/**
 * @fileoverview ESLint rule — no `pt-*` / `pb-*` overrides on the
 * gap-based Card slots.
 *
 * The Card primitive is gap-based, not padding-based
 * (`src/components/ui/card.tsx`): the header→body distance comes from
 * the PARENT flex gap, never from slot padding. A `pb-*` on
 * `<CardHeader>` or a `pt-*` on `<CardContent>` therefore adds on top
 * of the gap (or is a no-op) and inverts its own intent — the drift
 * class the sl-001 sweep cleaned (~35 stale overrides). Density is
 * expressed on the Card itself (`<Card className="gap-2 py-3 md:py-4">`,
 * the sanctioned compact tier), never on a slot.
 *
 * Detection: JSX elements named `CardHeader` / `CardContent` (any
 * member-expression tail, so `UI.CardHeader` matches too) whose
 * `className` attribute carries a static `pt-<n>` / `pb-<n>` fragment —
 * including modifier-prefixed (`md:pb-2`) and arbitrary-value
 * (`pb-[10px]`) forms. Strings are collected from the whole attribute
 * subtree, so `cn("pb-2", …)`, ternaries, and template literals are all
 * seen. Non-numeric suffixes (`pb-safe`) never match.
 *
 * Scope: `src/components/**` + `src/app/**`; test files exempt — same
 * gating as the sibling rules. `src/components/ui/card.tsx` itself
 * composes raw `<div>`s and is untouched by construction.
 *
 * There is deliberately NO allowlist: no current site has a documented
 * load-bearing reason for a slot padding override. If one ever appears,
 * it carries an inline `eslint-disable-next-line` with the reason —
 * visible in review — rather than a silent registry entry here.
 *
 * @see .planning/audits/2026-07-05-fable/UI-STANDARDS.md §1 + §2.
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
        "Ban pt-*/pb-* overrides on CardHeader/CardContent — the Card is gap-based; density is expressed via the Card's own gap/py, never via slot padding.",
    },
    schema: [],
    messages: {
      slotPadding:
        '"{{match}}" on <{{element}}> fights the gap-based Card contract — the header→body distance comes from the parent flex gap, so slot padding stacks on top of it (or is a no-op). Tune density on the Card itself instead: <Card className="gap-2 py-3 md:py-4">.',
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename?.();
    if (!filename || !isEnforced(filename)) {
      return {};
    }

    return {
      JSXOpeningElement(node) {
        const name = elementName(node);
        if (!name || !SLOT_NAMES.has(name)) return;

        const classNameAttr = node.attributes.find(
          (attr) =>
            attr.type === "JSXAttribute" &&
            attr.name?.type === "JSXIdentifier" &&
            attr.name.name === "className",
        );
        if (!classNameAttr) return;

        const strings = [];
        collectStrings(classNameAttr.value, strings);
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
      },
    };
  },
};

module.exports = spacingScaleRule;
