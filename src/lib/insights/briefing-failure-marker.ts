import { prisma } from "@/lib/db";

/**
 * Dated failure marker for the daily-briefing generation.
 *
 * The briefing keeps its last good payload on a failed refresh: the generator
 * writes NO `User.insightsCachedText` row when a provider times out or errors,
 * so the previous briefing stays intact and the surface never blanks. What was
 * missing is a signal the READ path can use to tell the difference between "no
 * refresh was due" and "the last refresh attempt failed" — without that, a
 * stale-but-shown briefing reads as current and a never-generated one shows a
 * generic empty state instead of an honest "couldn't generate".
 *
 * This records an append-only `auditLog` row (no migration, no overwrite of the
 * cached text) carrying the calendar day, the reason, and the locale. The read
 * path compares the latest marker's timestamp against the last successful
 * generation (`User.insightsCachedAt`): a marker newer than the last success
 * means the most recent attempt failed.
 */
export const BRIEFING_FAILURE_ACTION = "insights.briefing-failure";

/** UTC YYYY-MM-DD calendar-day key for the marker payload. */
function dateKey(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Append a failure marker for `userId`. Best-effort: a write failure here must
 * never propagate out of the generation's own failure path.
 */
export async function recordBriefingFailure(args: {
  userId: string;
  reason: string;
  locale?: string;
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: args.userId,
        action: BRIEFING_FAILURE_ACTION,
        details: JSON.stringify({
          dateKey: dateKey(),
          reason: args.reason,
          locale: args.locale ?? null,
          triedAt: new Date().toISOString(),
        }),
      },
    });
  } catch {
    // Marker is best-effort — never throw out of the failure path.
  }
}

export interface BriefingFailureState {
  triedAt: string;
  reason: string;
}

/**
 * Read the latest briefing-failure marker for `userId`, but only when it is
 * newer than the last successful generation (`since`). Returns `null` when the
 * most recent attempt succeeded (or there is no marker at all), so the read
 * path can render a discreet "couldn't refresh" hint exactly when it applies.
 */
export async function readBriefingFailure(args: {
  userId: string;
  since: Date | null;
}): Promise<BriefingFailureState | null> {
  const latest = await prisma.auditLog.findFirst({
    where: { userId: args.userId, action: BRIEFING_FAILURE_ACTION },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, details: true },
  });
  if (!latest) return null;
  // A failure older than (or equal to) the last successful generation has been
  // superseded — the surface is showing fresh text, not a held one.
  if (args.since && latest.createdAt <= args.since) return null;

  let reason = "unknown";
  if (latest.details) {
    try {
      const parsed = JSON.parse(latest.details) as { reason?: unknown };
      if (typeof parsed.reason === "string") reason = parsed.reason;
    } catch {
      // Malformed marker payload — still report the failure, generic reason.
    }
  }
  return { triedAt: latest.createdAt.toISOString(), reason };
}
