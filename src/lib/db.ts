import { Prisma, PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/**
 * v1.4.40 W-POOL — Prisma `pg.Pool` ceiling raised from the library
 * default of 10 → 20.
 *
 * The v1.4.39 empirical cold-mount trace
 * (`.planning/round-v1439-empirical-trace.md` § B2) showed thick
 * `/api/analytics` holding ≥ 8 of the 10 default pool slots for
 * 6.5 s on the maintainer's 347k-row tenant, starving every other Wave-B and
 * Wave-C useQuery fan-out for the duration. The production Postgres runs a
 * `max_connections` of 200 (raised from the stock 100), so a 20-slot
 * Node-side pool sits well under the server's hard cap with plenty of
 * headroom for concurrent power-users. Note the web + worker containers
 * share this one Postgres, so the effective ceiling covers both pools.
 * Complements the W-POOL `p-limit(4)` cap on the analytics fan-out itself —
 * the bounded concurrency keeps any single analytics call to ≤ 4 slots, so
 * the remaining 16 stay available for every other dashboard query.
 *
 * Env-overridable via `DATABASE_POOL_MAX` so an operator running
 * with a smaller Postgres `max_connections` can dial down without a
 * code change.
 */
export function getPoolMax(): number {
  const raw = process.env.DATABASE_POOL_MAX;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 20;
}

/**
 * Per-session DB statement timeout in milliseconds.
 *
 * Without this a single pathological query or lock wait holds one of the
 * (default 20) pool slots indefinitely; 20 such queries permanently exhaust
 * the pool and every DB-backed route stops serving — the single highest-impact
 * availability gap (A-1). `statement_timeout` caps how long the server runs one
 * statement; `idle_in_transaction_session_timeout` reaps a connection wedged
 * mid-transaction (a client that opened a tx and stalled). Both are applied at
 * connection-establishment via the libpq `options` startup parameter, so every
 * pooled session inherits them.
 *
 * Env-overridable via `DATABASE_STATEMENT_TIMEOUT_MS`. Set to `0` to disable
 * (legacy unbounded behaviour). Default 15 s — generous for the rollup-backed
 * read paths while still bounding a runaway query well before it can starve the
 * pool. Heavy admin one-shots (drain/backfill) run on the worker, not the web
 * pool, and can dial their own timeout if needed.
 */
export function getStatementTimeoutMs(): number {
  const raw = process.env.DATABASE_STATEMENT_TIMEOUT_MS;
  if (raw !== undefined && raw !== "") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 15_000;
}

/**
 * Build the libpq `options` startup string applying the session timeouts, or
 * `undefined` when disabled (timeout 0). Passed straight through `PrismaPg` to
 * the underlying `pg.Pool`, which forwards it as the connection's `options`
 * startup parameter so every session is timeout-bounded from the first query.
 */
export function buildSessionOptions(): string | undefined {
  const timeoutMs = getStatementTimeoutMs();
  if (timeoutMs <= 0) return undefined;
  return `-c statement_timeout=${timeoutMs} -c idle_in_transaction_session_timeout=${timeoutMs}`;
}

function createPrismaClient() {
  const sessionOptions = buildSessionOptions();
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL!,
    max: getPoolMax(),
    ...(sessionOptions ? { options: sessionOptions } : {}),
  });
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

// Prisma's `InputJsonValue` requires an explicit index signature that
// typed application shapes (Zod-validated, hand-written interfaces)
// don't carry. Every JSON-column write would otherwise repeat the same
// `value as unknown as Prisma.InputJsonValue` escape hatch — this one
// helper centralises the cast so the WHY stays in a single place.
export const toJson = <T>(v: T) => v as unknown as Prisma.InputJsonValue;
