/**
 * Shared plumbing for the reminder-worker handler modules: the worker-local Prisma client, the stdout logger, and the HH:mm parser.
 *
 * Extracted from reminder-worker.ts, which owns the queue names, cron
 * schedules, and boss.work registrations.
 */
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

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

// Reuse a single PrismaClient across all job handlers to avoid connection pool exhaustion

let workerPrisma: PrismaClient | null = null;

export function getWorkerPrisma(): PrismaClient {
  if (!workerPrisma) {
    const adapter = new PrismaPg({ connectionString: DATABASE_URL });
    workerPrisma = new PrismaClient({ adapter });
  }
  return workerPrisma;
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
