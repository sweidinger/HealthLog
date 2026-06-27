/**
 * v1.22 (B2/M4) — daily Coach-reminder sweep.
 *
 * The active scheduler the "remind me" complaint needs: a single indexed query
 * per tick that brings a reminder back at its chosen moment. Two sources:
 *
 *   1. `CoachReminder` rows that are date-triggered, `active`, and whose `dueAt`
 *      has passed → flipped to `due` (the in-app tile + indicator read `due` /
 *      `surfaced`). `lastSurfacedAt` is stamped + `surfaceCount` bumped.
 *   2. `CoachPlan` rows whose dangling `reviewDate` (written nowhere, read
 *      nowhere until now — see the design §1c) has passed and that are still
 *      `active` → a one-off `CoachReminder` is minted from the plan's own
 *      cue→action text (relatedPlanId set, source `extractor`) and the plan's
 *      `reviewDate` is cleared so the review fires once. This finally activates
 *      the column the B1 schema anticipated.
 *
 * In-app surfacing ONLY in this wave: push delivery + the receptivity gate (B4)
 * land later. The sweep never calls a provider and never pushes — it only flips
 * status + mints the plan-review reminder, both idempotent across re-fires.
 *
 * Context-cue reminders (`triggerKind: "context"`) are NOT evaluated here — that
 * is a follow-on (F4); the column exists and capture supports it, but the date
 * sweep is the high-value slice.
 */
import type { PrismaClient } from "@/generated/prisma/client";

import { decryptFromBytes, encryptToBytes } from "@/lib/ai/coach/bytes-codec";

export const COACH_REMINDER_SWEEP_QUEUE = "coach-reminder-sweep";
// Daily at 05:20 Europe/Berlin — just after the 05:15 nudge tick so both
// proactive passes run on settled overnight rows.
export const COACH_REMINDER_SWEEP_CRON = "20 5 * * *";

/** Bound the plan-review fan-out per tick so one sweep can't run unbounded. */
const PLAN_REVIEW_BATCH = 200;

export interface CoachReminderSweepSummary {
  remindersDue: number;
  planReviewsMinted: number;
  errored: number;
}

type SweepPrisma = Pick<
  PrismaClient,
  "coachReminder" | "coachPlan" | "$transaction"
>;

/**
 * Run one sweep tick. Idempotent: a reminder already `due` is not re-flipped,
 * and a plan whose `reviewDate` was cleared on a prior tick is not re-minted.
 */
export async function runCoachReminderSweep(
  prisma: SweepPrisma,
  now: Date = new Date(),
): Promise<CoachReminderSweepSummary> {
  const summary: CoachReminderSweepSummary = {
    remindersDue: 0,
    planReviewsMinted: 0,
    errored: 0,
  };

  // ── 1. flip overdue active date-reminders → due ──────────────
  const due = await prisma.coachReminder.updateMany({
    where: {
      deletedAt: null,
      status: "active",
      triggerKind: "date",
      dueAt: { not: null, lte: now },
    },
    data: {
      status: "due",
      lastSurfacedAt: now,
      surfaceCount: { increment: 1 },
    },
  });
  summary.remindersDue = due.count;

  // ── 2. mint plan-review reminders for passed reviewDates ──────
  const plans = await prisma.coachPlan.findMany({
    where: {
      deletedAt: null,
      status: "active",
      reviewDate: { not: null, lte: now },
    },
    take: PLAN_REVIEW_BATCH,
    select: {
      id: true,
      userId: true,
      metric: true,
      ifCueEncrypted: true,
      thenActionEncrypted: true,
    },
  });

  for (const plan of plans) {
    try {
      // The note is the plan's OWN cue→action prose (the user's words), never
      // fabricated. Decrypt fault-isolated — an undecryptable plan is skipped
      // (its reviewDate stays so a future key fix can still surface it).
      let note: string;
      try {
        const ifCue = decryptFromBytes(plan.ifCueEncrypted);
        const thenAction = decryptFromBytes(plan.thenActionEncrypted);
        note = `${ifCue} → ${thenAction}`.slice(0, 280);
      } catch {
        summary.errored += 1;
        continue;
      }

      // Mint the reminder and clear the plan's reviewDate atomically: if the
      // clear failed after a standalone create committed, the next tick would
      // re-select the plan (reviewDate still set) and mint a DUPLICATE review
      // reminder. One transaction makes the pair all-or-nothing.
      await prisma.$transaction([
        prisma.coachReminder.create({
          data: {
            userId: plan.userId,
            noteEncrypted: encryptToBytes(note),
            metric: plan.metric,
            relatedPlanId: plan.id,
            triggerKind: "date",
            dueAt: now,
            status: "due",
            source: "extractor",
            lastSurfacedAt: now,
            surfaceCount: 1,
          },
        }),
        prisma.coachPlan.update({
          where: { id: plan.id },
          data: { reviewDate: null },
        }),
      ]);
      summary.planReviewsMinted += 1;
    } catch {
      summary.errored += 1;
    }
  }

  return summary;
}
