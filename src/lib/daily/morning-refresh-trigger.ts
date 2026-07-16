/**
 * S4 — the sleep-arrival trigger for the morning digest refresh.
 *
 * The nightly insight pre-pass (`insight-pregenerate`, 04:30) runs before last
 * night's sleep has synced, so the morning digest + health score reference the
 * day WITHOUT the current sleep. This trigger closes that gap the event-driven
 * way: when a completed sleep segment for LAST NIGHT lands from any of the
 * three sleep transports (Withings sync-sleep / the WHOOP sync / the
 * Apple-Health measurement batch), it enqueues a debounced
 * `morning-digest-refresh` job that re-runs the sleep-dependent generation and
 * flips the day `provisional → final`.
 *
 * There is no single canonical sleep-persist function in the tree — each
 * transport upserts through its own helper — so the three write seams each call
 * `maybeEnqueueMorningRefresh` with the measuredAt of every sleep row they just
 * wrote. The debounce (queue `singletonKey` + the `User.morningDigestRefreshedOn`
 * marker) collapses the many samples of one night, and across all three
 * sources, into ONE refresh per user per local morning.
 *
 * Timezone correctness is load-bearing: "last night" is judged in the user's
 * PROFILE timezone, never UTC, so a 30-day backfill re-sync never re-triggers
 * for historical nights and a sleep that is "last night" locally but a
 * different UTC date still triggers.
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { resolveModuleMap } from "@/lib/modules/gate";
import { userDayKey } from "@/lib/tz/format";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { enqueueMorningDigestRefresh } from "@/lib/jobs/morning-digest-refresh-shared";

const MS_PER_DAY = 86_400_000;

/**
 * True when `measuredAt` belongs to "last night" for an observer in `tz`: its
 * local calendar date is today or yesterday. An older backfilled segment (local
 * date ≥ 2 days ago) returns false, so a full WHOOP / Apple / Withings re-sync
 * that replays a month of nights never re-triggers the morning refresh for a
 * historical night. A future-dated sample (clock skew) is rejected too.
 *
 * Pure + timezone-explicit so the tz-boundary cases are unit-testable without
 * touching the DB or the queue.
 */
export function isLastNightLocal(
  measuredAt: Date,
  now: Date,
  tz: string,
): boolean {
  if (measuredAt.getTime() > now.getTime()) return false;
  const todayKey = userDayKey(now, tz);
  const yesterdayKey = userDayKey(new Date(now.getTime() - MS_PER_DAY), tz);
  const segKey = userDayKey(measuredAt, tz);
  return segKey === todayKey || segKey === yesterdayKey;
}

/**
 * Enqueue the debounced morning refresh when at least one of the just-written
 * sleep segments belongs to last night in the user's profile timezone.
 *
 * Best-effort and self-contained: every read is wrapped so a failure can never
 * fail the sleep sync that called it. Callers still `void … .catch(() => {})`
 * for defence in depth.
 *
 * Gates, in order:
 *   1. No sleep rows → nothing to do.
 *   2. `sleep` module off → the digest is always `final` (no sleep to wait
 *      for), so a refresh would be pointless; no-op.
 *   3. No segment is "last night" locally → an old backfill; no-op.
 *   4. `User.morningDigestRefreshedOn` already equals today's local date → the
 *      refresh already ran this morning; skip the enqueue (the handler
 *      re-checks the same marker, so this only saves queue churn).
 */
export async function maybeEnqueueMorningRefresh(
  userId: string,
  sleepMeasuredAts: Date[],
  now: Date = new Date(),
): Promise<void> {
  try {
    if (sleepMeasuredAts.length === 0) return;

    const modules = await resolveModuleMap(userId);
    if (modules.sleep === false) return;

    const tz = await resolveUserTimezone(userId);
    const hasLastNight = sleepMeasuredAts.some((at) =>
      isLastNightLocal(at, now, tz),
    );
    if (!hasLastNight) return;

    const localDate = userDayKey(now, tz);

    const row = await prisma.user.findUnique({
      where: { id: userId },
      select: { morningDigestRefreshedOn: true },
    });
    if (row?.morningDigestRefreshedOn === localDate) return;

    await enqueueMorningDigestRefresh({ userId, localDate });
    annotate({
      action: { name: "daily.morning_refresh.triggered" },
      meta: {
        local_date: localDate,
        sleep_samples: sleepMeasuredAts.length,
      },
    });
  } catch {
    // Never let a freshness trigger fail an ingest. The next sleep landing and
    // the nightly cron are the catch-net; the digest stays honestly
    // provisional until one of them refreshes it.
  }
}
