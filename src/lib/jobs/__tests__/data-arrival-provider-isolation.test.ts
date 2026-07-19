/**
 * Structural guard: the data-arrival worker cannot reach a provider.
 *
 * The spine's central cost claim is that it spends nothing. That claim is only
 * as good as the worker's module graph: the moment anything reachable from
 * `data-arrival.ts` imports a provider client, a mass ingest becomes a mass of
 * provider calls, and no amount of runtime gating in the handler would show up
 * in review as the thing that broke it.
 *
 * So the guard is structural, not behavioural. It BFS-walks the static import
 * graph from the worker and asserts no provider module is reachable — the shape
 * of `documents/__tests__/fenced-chat-module-graph.test.ts`.
 *
 * Two deliberate design points:
 *
 *   - The forbidden set is GLOBBED, not hand-listed, for the provider clients.
 *     A hand-written array silently stops covering a `gemini-client.ts` the day
 *     someone adds one; a glob covers it on arrival.
 *   - There is a positive control. A graph walk that silently resolves to
 *     nothing (a moved file, a changed alias, a typo in the entry path) would
 *     pass every negative assertion vacuously. The control asserts the walk
 *     DOES reach the modules the worker genuinely uses, so an empty graph fails
 *     loudly instead of reporting success.
 *
 * Known limit, stated because it bounds what this proves: `IMPORT_RE` sees only
 * static import specifiers. A dynamic `await import(...)` built from a variable
 * is invisible to it. That is acceptable here — the ban is on a static import,
 * and a dynamic provider import in a worker would be a far louder thing to
 * write — but it is not a proof, it is a tripwire.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "../../..");

const WORKER_ENTRY = resolve(SRC, "lib/jobs/data-arrival.ts");
const EMIT_ENTRY = resolve(SRC, "lib/arrivals/emit-shared.ts");

/** Non-client provider machinery. Hand-listed because it has no shared suffix. */
const PROVIDER_MACHINERY = [
  "lib/ai/provider.ts",
  "lib/ai/provider-runner.ts",
  "lib/ai/provider-chain.ts",
  "lib/ai/provider-health-ledger.ts",
  "lib/ai/openai-wire.ts",
  "lib/ai/codex-oauth.ts",
].map((p) => resolve(SRC, p));

/** Every `*-client.ts` under `src/lib/ai`, discovered rather than enumerated. */
function providerClients(): string[] {
  const dir = resolve(SRC, "lib/ai");
  return readdirSync(dir)
    .filter((f) => f.endsWith("-client.ts"))
    .map((f) => resolve(dir, f));
}

function resolveSpecifier(spec: string, fromFile: string): string | null {
  let candidate: string;
  if (spec.startsWith("@/")) {
    candidate = resolve(SRC, spec.slice(2));
  } else if (spec.startsWith(".")) {
    candidate = resolve(dirname(fromFile), spec);
  } else {
    return null; // bare package import — outside our graph
  }
  for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    const p = `${candidate}${ext}`;
    if (existsSync(p)) return p;
  }
  return existsSync(candidate) ? candidate : null;
}

const IMPORT_RE = /(?:from|import)\s+["']([^"']+)["']/g;

/** BFS the static import graph from `entries`, returning every reachable file. */
function reachableFrom(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const match of source.matchAll(IMPORT_RE)) {
      const resolved = resolveSpecifier(match[1], file);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
}

describe("data-arrival spine — provider isolation", () => {
  it("the worker's module graph reaches no provider client", () => {
    const reachable = reachableFrom([WORKER_ENTRY]);
    const clients = providerClients();
    expect(clients.length).toBeGreaterThan(0); // the glob itself must not be empty
    for (const forbidden of clients) {
      expect(
        reachable.has(forbidden),
        `The data-arrival worker must NOT be able to reach ${forbidden}. The spine's cost claim is that it spends nothing; a provider import here voids it.`,
      ).toBe(false);
    }
  });

  it("the worker's module graph reaches no provider resolver or wire module", () => {
    const reachable = reachableFrom([WORKER_ENTRY]);
    for (const forbidden of PROVIDER_MACHINERY) {
      if (!existsSync(forbidden)) continue; // tolerate a renamed internal
      expect(
        reachable.has(forbidden),
        `The data-arrival worker must NOT be able to reach ${forbidden}.`,
      ).toBe(false);
    }
  });

  it("the emit seam's module graph reaches no provider client either", () => {
    // The seams run inside every ingest request. A provider import here would
    // be worse than in the worker: it would land on the request hot path.
    const reachable = reachableFrom([EMIT_ENTRY]);
    for (const forbidden of providerClients()) {
      expect(
        reachable.has(forbidden),
        `The arrival emit seam must NOT be able to reach ${forbidden}.`,
      ).toBe(false);
    }
  });

  it("sanity: the walk DOES reach the worker's own dependencies", () => {
    // Positive control. Without this, a broken entry path or a changed alias
    // would make every assertion above pass against an empty graph.
    const reachable = reachableFrom([WORKER_ENTRY]);
    expect(reachable.has(resolve(SRC, "lib/arrivals/types.ts"))).toBe(true);
    expect(reachable.has(resolve(SRC, "lib/arrivals/emit-shared.ts"))).toBe(
      true,
    );
    expect(reachable.has(resolve(SRC, "lib/cache/invalidate.ts"))).toBe(true);
  });

  it("sanity: the walk CAN see a provider client when one is genuinely imported", () => {
    // Second positive control, on the detector rather than the graph: point the
    // walk at a module that really does import a provider and assert it is
    // found. If this ever goes red, the negative assertions above have stopped
    // meaning anything.
    const chainEntry = resolve(SRC, "lib/ai/provider.ts");
    const reachable = reachableFrom([chainEntry]);
    const clients = providerClients();
    expect(clients.some((c) => reachable.has(c))).toBe(true);
  });
});
