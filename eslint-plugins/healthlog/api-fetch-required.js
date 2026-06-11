/**
 * @fileoverview ESLint rule — client-side `/api/...` calls must route
 * through the typed `apiFetch` wrapper.
 *
 * `src/lib/api/api-fetch.ts` owns the `.ok` check, the
 * `{ data, error, meta? }` envelope unwrap, and the `ApiError` shape
 * (message via `readError`, `status`, error-side `meta`). A raw
 * `fetch("/api/…")` in a component re-implements that contract by hand
 * — the exact drift this wrapper retired — so this rule flags it at
 * authoring time and in CI.
 *
 * Complements `healthlog/safe-fetch-required`: that rule covers
 * OUTBOUND egress (absolute / variable-sourced URLs) and exempts
 * same-origin relative paths; this rule covers exactly those same-origin
 * `/api/...` paths inside the client surface.
 *
 * Allowed:
 *   - `apiFetch` / verb helpers / `apiFetchEnvelope` / `apiFetchRaw` —
 *     distinct identifiers, never match.
 *   - calls inside `src/lib/api/api-fetch.ts` — the wrapper's own `fetch`.
 *   - test files (`*.test.ts(x)`, `__tests__/`, `__mocks__/`) — they
 *     mock or assert against `fetch` directly.
 *
 * The check is a syntactic `CallExpression` match against a bare
 * `fetch(` callee (Identifier `fetch`) and `globalThis.fetch(` /
 * `window.fetch(` / `self.fetch(` member forms, where the first
 * argument is a string literal or template literal whose head starts
 * with `/api/`. Variable-sourced or absolute URLs are the
 * safe-fetch-required rule's territory and stay out of scope here.
 *
 * @see src/lib/api/api-fetch.ts
 * @see eslint-plugins/healthlog/safe-fetch-required.js
 */

"use strict";

// Files exempt from the rule — the wrapper internals and the test
// surface. Posix-style suffix matches against the absolute filename via
// `String#includes`, mirroring the safe-fetch-required convention.
const EXEMPT_FILES = ["src/lib/api/api-fetch.ts"];

// Enforce across the client-facing source roots. `src/lib/` stays out:
// server-side lib code never self-calls `/api/` routes, and the
// safe-fetch rule already covers its outbound calls.
const ENFORCED_ROOTS = ["src/components/", "src/app/"];

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
const apiFetchRequiredRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Same-origin /api/ calls must route through the apiFetch wrapper (src/lib/api/api-fetch.ts).",
    },
    schema: [],
    messages: {
      rawApiFetch:
        'Raw fetch("/api/…") re-implements the envelope unwrap + error contract by hand. Import { apiFetch } (or a verb helper / apiFetchRaw) from "@/lib/api/api-fetch" and call it instead.',
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename?.();
    if (!filename || !isEnforced(filename)) {
      return {};
    }

    function isFetchCallee(callee) {
      // Bare `fetch(...)`.
      if (callee.type === "Identifier" && callee.name === "fetch") return true;
      // `globalThis.fetch(...)` / `window.fetch(...)` / `self.fetch(...)`.
      if (
        callee.type === "MemberExpression" &&
        !callee.computed &&
        callee.property.type === "Identifier" &&
        callee.property.name === "fetch" &&
        callee.object.type === "Identifier" &&
        (callee.object.name === "globalThis" ||
          callee.object.name === "window" ||
          callee.object.name === "self")
      ) {
        return true;
      }
      return false;
    }

    function isApiPath(arg) {
      if (!arg) return false;
      const isApiHead = (head) => head.startsWith("/api/");
      // `fetch("/api/…")`
      if (arg.type === "Literal" && typeof arg.value === "string") {
        return isApiHead(arg.value);
      }
      // `fetch(`/api/${id}`)` — inspect the template's first cooked chunk.
      if (arg.type === "TemplateLiteral" && arg.quasis.length > 0) {
        return isApiHead(arg.quasis[0].value.cooked ?? "");
      }
      return false;
    }

    return {
      CallExpression(node) {
        if (!isFetchCallee(node.callee)) return;
        if (!isApiPath(node.arguments[0])) return;
        context.report({ node, messageId: "rawApiFetch" });
      },
    };
  },
};

module.exports = apiFetchRequiredRule;
