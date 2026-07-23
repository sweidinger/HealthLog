/**
 * Shared plumbing for the reminder-worker handler modules: the worker-local Prisma client, the stdout logger, and the HH:mm parser.
 *
 * Extracted from reminder-worker.ts, which owns the queue names, cron
 * schedules, and boss.work registrations.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";

export function parseTimeToMinutes(value: string): number {
  const [h, m] = value.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  // Some Node ICU builds render midnight as "24:00" via toLocaleTimeString.
  // Normalize so comparisons against schedule windows that wrap midnight
  // don't produce a 1440-minute value.
  const hours = h === 24 ? 0 : h;
  return hours * 60 + m;
}

export const DATABASE_URL = process.env.DATABASE_URL!;

// Boot-backfill stagger step (seconds). The self-converging full-history
// backfills are each `localConcurrency: 1` in isolation, but all of them used
// to drain from the very first pg-boss poll at worker boot — on a heavy tenant
// that meant ~half a dozen full-history loads contending for the same
// connection pool at once (a boot storm / crash-loop risk). The boot-discovery
// wrappers hand each backfill type an increasing multiple of this step as a
// `startAfter` delay so their loads start at staggered times instead of all on
// the first poll. Non-boot callers (cron) pass no offset and keep their
// immediate semantics.
export const BOOT_BACKFILL_STAGGER_SECONDS = 30;

// Every queue handler shares the process-level client and its single bounded
// pg.Pool. Separate worker clients multiplied the configured connection limit.
export function getWorkerPrisma(): PrismaClient {
  return prisma;
}

/**
 * Internal logger that prefers structured Wide-Event annotations when a
 * worker context is active, and falls back to stderr only for true
 * lifecycle events that fire outside any handler (init, fatal startup
 * errors, shutdown). Avoids the historical pattern of `console.log`
 * everywhere in this file, which polluted production stdout and was
 * never queryable in Loki.
 */
export function workerLog(
  level: "info" | "error",
  msg: string,
  err?: unknown,
): void {
  if (level === "error") {
    // Errors during worker init or shutdown happen outside any request
    // context, so stderr is the only audience the operator has.
    if (err !== undefined) console.error(`[pg-boss] ${msg}`, err);
    else console.error(`[pg-boss] ${msg}`);
  }
  // info-level lifecycle messages are intentionally silent — pg-boss own
  // events surface state, and Wide Events from handlers carry the work.
}
