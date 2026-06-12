import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Client-safety pin for the verdict resolver's import graph.
 *
 * `resolveDashboardVerdict` runs inside the `"use client"` dashboard
 * hero, so every VALUE import reachable from `verdict.ts` must stay off
 * the server graph: no prisma, no `node:` builtins, no pg-boss, no
 * `@/lib/jobs/coach-nudge` (whose dispatcher/feature-flag imports pull
 * `node:async_hooks` — the exact regression class the dose-window
 * editor hit when it imported `DOSE_WINDOW_DEFAULTS` from
 * `@/lib/analytics/compliance`; see
 * `src/lib/medications/scheduling/dose-window-defaults.ts`). The shared
 * nudge thresholds therefore live in the dependency-free
 * `@/lib/jobs/coach-nudge-thresholds` leaf.
 *
 * `import type` statements are erased by the compiler AND the bundler,
 * so the walker skips them — the `DashboardSnapshot` type import from
 * `@/lib/dashboard/snapshot` (a heavy server module) is legal exactly
 * as long as it stays type-only. If someone drops the `type` keyword,
 * the walker traverses into the snapshot builder and this suite fails.
 */

const SRC = join(process.cwd(), "src");
const ENTRY = join(SRC, "lib/dashboard/verdict.ts");

/** Specifier patterns that mark a server-only dependency. */
const BANNED_SPECIFIERS: RegExp[] = [
  /^node:/,
  /^@\/generated\//,
  /^@\/lib\/db$/,
  /^@prisma\//,
  /^pg-boss$/,
  /^server-only$/,
  /^@\/lib\/jobs\/coach-nudge$/,
];

/**
 * Extract VALUE-import specifiers from a module. Type-only statements
 * (`import type … from`, `export type … from`) are erased at build
 * time and skipped. Side-effect imports (`import "x"`) are included.
 */
function valueImportSpecifiers(source: string): string[] {
  const out: string[] = [];
  // Statement-anchored (`^import` / `^export`) and semicolon-bounded
  // (`[^;]*?`) so the lazy scan can never swallow across statements or
  // latch onto a `from "…"` inside an unrelated string / comment.
  const stmt =
    /^(import|export)(\s+type)?\s+[^;"']*?from\s*["']([^"']+)["']|^import\s*["']([^"']+)["']/gm;
  let m: RegExpExecArray | null;
  while ((m = stmt.exec(source)) !== null) {
    if (m[4] !== undefined) {
      out.push(m[4]); // bare side-effect import
      continue;
    }
    if (m[2] !== undefined) continue; // `import type` / `export type` — erased
    out.push(m[3]);
  }
  return out;
}

/** Resolve `@/…` and relative specifiers to a file inside `src/`. */
function resolveLocal(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null; // external package
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  throw new Error(`unresolvable local import "${spec}" from ${fromFile}`);
}

function walkGraph(entry: string): {
  visited: Set<string>;
  specifiers: Set<string>;
} {
  const visited = new Set<string>();
  const specifiers = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    for (const spec of valueImportSpecifiers(readFileSync(file, "utf8"))) {
      specifiers.add(spec);
      const local = resolveLocal(spec, file);
      if (local !== null) queue.push(local);
    }
  }
  return { visited, specifiers };
}

describe("verdict.ts — client-safe import graph", () => {
  const { visited, specifiers } = walkGraph(ENTRY);

  it("carries no server-only specifier anywhere in the value-import graph", () => {
    const offenders = [...specifiers].filter((spec) =>
      BANNED_SPECIFIERS.some((re) => re.test(spec)),
    );
    expect(offenders).toEqual([]);
  });

  it("never traverses into the snapshot builder (type-only boundary holds)", () => {
    const snapshotModule = join(SRC, "lib/dashboard/snapshot.ts");
    expect(visited.has(snapshotModule)).toBe(false);
  });

  it("reads the nudge thresholds from the dependency-free leaf", () => {
    expect(specifiers.has("@/lib/jobs/coach-nudge-thresholds")).toBe(true);
    const leaf = readFileSync(
      join(SRC, "lib/jobs/coach-nudge-thresholds.ts"),
      "utf8",
    );
    expect(valueImportSpecifiers(leaf)).toEqual([]);
  });

  it("the whole graph stays local — no external runtime package rides in", () => {
    const external = [...specifiers].filter(
      (spec) => !spec.startsWith("@/") && !spec.startsWith("."),
    );
    expect(external).toEqual([]);
  });
});
