#!/usr/bin/env tsx
/**
 * Post-deploy version assertion.
 *
 * Polls `/api/version` on production + demo and asserts the running
 * build's `data.version` matches an expected value, printing each
 * target's `buildSha`. Exits non-zero on a mismatch or after the retry
 * window elapses — so a CI step or a manual deploy can fail loudly when
 * the `:latest` pull served the prior image (the recurring BuildKit
 * layer-cache pitfall where Coolify reports "deployed" while
 * `/api/version` still answers the old number).
 *
 * Run it after every deploy — the queued-deploy status is not the source
 * of truth, the served version is:
 *
 *   pnpm dlx tsx scripts/assert-deploy.ts <expected-version>
 *
 * Examples:
 *
 *   # assert both prod + demo serve 1.9.0
 *   pnpm dlx tsx scripts/assert-deploy.ts 1.9.0
 *
 *   # assert prod only
 *   pnpm dlx tsx scripts/assert-deploy.ts 1.9.0 --only=prod
 *
 *   # widen the retry window (default 24 attempts × 5s = 2 min)
 *   pnpm dlx tsx scripts/assert-deploy.ts 1.9.0 --attempts=60 --interval=5000
 *
 * Pure script — strips the leading `v` from the expected version so both
 * `v1.9.0` and `1.9.0` work. No app-library import, no runtime wiring;
 * the standalone image never ships this file.
 */

interface Target {
  name: string;
  url: string;
}

const TARGETS: Record<string, Target> = {
  prod: { name: "prod", url: "https://healthlog.bombeck.io/api/version" },
  demo: { name: "demo", url: "https://demo.healthlog.dev/api/version" },
};

interface VersionPayload {
  version?: string;
  buildSha?: string | null;
  builtAt?: string | null;
}

function parseArgs(argv: string[]): {
  expected: string;
  attempts: number;
  intervalMs: number;
  only: string | null;
} {
  const positional: string[] = [];
  let attempts = 24;
  let intervalMs = 5_000;
  let only: string | null = null;

  for (const arg of argv) {
    if (arg.startsWith("--attempts=")) {
      attempts = Number.parseInt(arg.slice("--attempts=".length), 10);
    } else if (arg.startsWith("--interval=")) {
      intervalMs = Number.parseInt(arg.slice("--interval=".length), 10);
    } else if (arg.startsWith("--only=")) {
      only = arg.slice("--only=".length);
    } else {
      positional.push(arg);
    }
  }

  const expected = (positional[0] ?? "").trim().replace(/^v/, "");
  if (!expected) {
    console.error(
      "usage: pnpm dlx tsx scripts/assert-deploy.ts <expected-version> [--only=prod|demo] [--attempts=N] [--interval=ms]",
    );
    process.exit(2);
  }
  if (!Number.isFinite(attempts) || attempts < 1) attempts = 24;
  if (!Number.isFinite(intervalMs) || intervalMs < 0) intervalMs = 5_000;

  return { expected, attempts, intervalMs, only };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((res) => setTimeout(res, ms));

/** One probe. Returns the parsed payload or null on any transport / shape error. */
async function probe(url: string): Promise<VersionPayload | null> {
  try {
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: VersionPayload } | null;
    return body?.data ?? null;
  } catch {
    return null;
  }
}

/**
 * Poll one target until its served version matches `expected` or the
 * retry window elapses. Resolves true on a match, false otherwise.
 */
async function assertTarget(
  target: Target,
  expected: string,
  attempts: number,
  intervalMs: number,
): Promise<boolean> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const payload = await probe(target.url);
    const version = payload?.version?.trim() ?? null;
    if (version === expected) {
      console.log(
        `[${target.name}] OK version=${version} buildSha=${payload?.buildSha ?? "—"}`,
      );
      return true;
    }
    const seen = version ?? "unreachable";
    console.log(
      `[${target.name}] attempt ${attempt}/${attempts}: expected ${expected}, got ${seen}`,
    );
    if (attempt < attempts) await sleep(intervalMs);
  }
  console.error(
    `[${target.name}] FAIL: ${target.url} did not report ${expected} within ${attempts} attempts`,
  );
  return false;
}

async function main(): Promise<void> {
  const { expected, attempts, intervalMs, only } = parseArgs(
    process.argv.slice(2),
  );

  let selected: Target[];
  if (only) {
    const picked = TARGETS[only];
    if (!picked) {
      console.error(`unknown --only target: ${only} (use prod or demo)`);
      process.exit(2);
    }
    selected = [picked];
  } else {
    selected = Object.values(TARGETS);
  }

  console.log(
    `Asserting version ${expected} on: ${selected.map((t) => t.name).join(", ")}`,
  );

  // Probe targets in parallel; each runs its own bounded retry loop.
  const results = await Promise.all(
    selected.map((t) => assertTarget(t, expected, attempts, intervalMs)),
  );

  if (results.every((ok) => ok)) {
    console.log("All targets serve the expected version.");
    process.exit(0);
  }
  process.exit(1);
}

void main();
