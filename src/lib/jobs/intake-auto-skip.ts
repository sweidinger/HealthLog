/**
 * v1.4.46 — hourly cron that gives a forgotten medication dose a terminal
 * state. Without it the dashboard "compliance" tile keeps counting a never-
 * acted dose as `pending` forever (the row's `takenAt` stays NULL), which
 * prevents the next day's intake from rendering cleanly in the "today"
 * window.
 *
 * v1.15.9 — the terminal state is now `auto_missed = true`, NOT
 * `skipped = true`. A forgotten dose is a real MISS — it must count against
 * adherence. The old behaviour flipped `skipped = true`, and because the
 * compliance engine EXCLUDES skipped doses from the denominator (a
 * deliberate user pause), a forgotten dose then vanished from the rate
 * entirely, silently inflating adherence. Setting `auto_missed` keeps the
 * never-acted dose distinct from a user-initiated skip: the engine pairs an
 * `auto_missed` slot to a `missed` status (counts against the rate) while a
 * `skipped` row stays excluded (a deliberate drug holiday).
 *
 * Rule: set `auto_missed = true` for every `MedicationIntakeEvent` where:
 *   * `skipped = false` AND
 *   * `auto_missed = false` AND
 *   * `takenAt IS NULL` AND
 *   * `scheduledFor < NOW() - INTERVAL '24 hours'`
 *
 * The 24 h grace window is intentional: a slightly late mark (user took the
 * morning dose at noon when the schedule was 09:00) shouldn't be flipped
 * before the user has had a full day to record it. Anything older than 24 h
 * is reliably forgotten — the compliance engine needs a terminal state to
 * count it as a real miss.
 *
 * Idempotent by construction: the second pass within the same hour finds
 * zero candidate rows because the first pass already flipped them. Safe to
 * re-run on worker restart.
 *
 * Compliance coupling: the engine-backed compliance paths read `auto_missed`
 * directly. The helper deliberately does NOT touch any rollup — the next
 * read-path call recomputes from the live rows.
 */
import type { PrismaClient } from "@/generated/prisma/client";

export const INTAKE_AUTO_SKIP_QUEUE = "intake-auto-skip";

/**
 * Cron schedule. Hourly at :05 so the tick doesn't collide with the
 * top-of-the-hour reminder-check (:00) or the moodlog-sync (:30)
 * cadences. Europe/Berlin matches the rest of the worker's schedules.
 */
export const INTAKE_AUTO_SKIP_CRON = "5 * * * *";

/**
 * Grace window before auto-skip kicks in. 24 h matches the spec and
 * the user's real-world cadence (late entries up to a full day after
 * the schedule are still legitimate).
 */
export const INTAKE_AUTO_SKIP_GRACE_HOURS = 24;

export interface IntakeAutoSkipPayload {
  triggeredAt: string;
}

export interface IntakeAutoSkipResult {
  /** Rows that flipped from pending to `auto_missed = true` on this pass. */
  skippedCount: number;
  /** Cutoff timestamp the pass applied — useful for the audit trail. */
  cutoff: Date;
}

/**
 * Run one auto-skip pass. Returns the flipped row count + the cutoff
 * the pass used. Pure function over the injected Prisma client so
 * unit tests can drive it with an in-memory fake.
 *
 * `nowMs` is injectable for the same testing reason — the production
 * caller passes `Date.now()`; tests pass a frozen instant so the
 * cutoff arithmetic is deterministic.
 */
export async function runIntakeAutoSkipPass(
  prisma: PrismaClient,
  options: { nowMs?: number } = {},
): Promise<IntakeAutoSkipResult> {
  const nowMs = options.nowMs ?? Date.now();
  const cutoff = new Date(
    nowMs - INTAKE_AUTO_SKIP_GRACE_HOURS * 60 * 60 * 1000,
  );

  const { count } = await prisma.medicationIntakeEvent.updateMany({
    where: {
      skipped: false,
      autoMissed: false,
      takenAt: null,
      scheduledFor: { lt: cutoff },
    },
    data: { autoMissed: true },
  });

  return { skippedCount: count, cutoff };
}
