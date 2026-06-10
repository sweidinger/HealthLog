/**
 * v1.15.20 — proactive Coach nudge (MVP).
 *
 * One daily cron tick (05:15 Europe/Berlin, after the nightly score
 * passes have settled) evaluates a small set of DETERMINISTIC triggers
 * per user and — when one fires — dispatches a single `COACH_NUDGE`
 * notification deep-linking to `/insights/coach`. No AI call happens
 * here: the triggers are plain arithmetic over already-persisted rows;
 * the Coach conversation the nudge invites the user into is where the
 * model gets involved.
 *
 * Gates, in order (the `status-cron-candidates` pattern):
 *   1. Operator kill-switch via `getAssistantFlags().coach` — the
 *      master assistant switch forces this off too.
 *   2. Per-user `disableCoach: false` — no Coach surface, no nudge.
 *   3. A working provider (`userRowHasProviderCredential`, including
 *      the operator's shared key) — a nudge into a Coach that cannot
 *      answer is worse than silence.
 *   4. Per-user opt-out: `notificationPrefs.coach.nudgesEnabled`
 *      (default ON; Settings → Notifications).
 *   5. Frequency cap: at most one nudge per rolling 7 days, anchored
 *      on the `push_attempts` ledger (`eventType = COACH_NUDGE`,
 *      `result = "ok"`) — no new table, 90-day retention dwarfs the
 *      7-day lookback, and a failed dispatch leaves the slot free.
 *
 * Triggers (first hit wins, evaluated cheapest-first):
 *   - `compliance`: 7-day medication adherence < 60 % with at least
 *     5 due doses (deliberate skips excluded — a planned break is not
 *     a compliance problem).
 *   - `bp`: 7-day systolic mean above the user's effective target
 *     (override-aware via `getEffectiveRange`) with ≥ 3 readings.
 *   - `score`: recovery score falling sharply — the last 7-day mean
 *     sits ≥ 15 points under the previous 7-day mean (≥ 3 samples in
 *     each window).
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { getAssistantFlags } from "@/lib/feature-flags";
import { userRowHasProviderCredential } from "@/lib/ai/provider";
import {
  getEffectiveRange,
  type ThresholdOverridesJson,
} from "@/lib/analytics/effective-range";
import { dispatchNotification } from "@/lib/notifications/dispatcher";
import { resolveCoachNudgesEnabled } from "@/lib/validations/notification-prefs";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import type { Locale } from "@/lib/i18n/config";
import { defaultLocale, locales } from "@/lib/i18n/config";
import { getEvent } from "@/lib/logging/context";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Pg-boss queue + cron — imported by the reminder worker's bootstrap. */
export const COACH_NUDGE_QUEUE = "coach-nudge";
/** 05:15 Europe/Berlin — after the 04:45–04:55 score crons settled. */
export const COACH_NUDGE_CRON = "15 5 * * *";

/** Frequency cap: one nudge per user per rolling week. */
export const COACH_NUDGE_MIN_INTERVAL_DAYS = 7;

/** Compliance trigger: 7-day rate below this fires (0..1). */
export const COACH_NUDGE_COMPLIANCE_THRESHOLD = 0.6;
/** Compliance trigger: minimum due doses before the rate is trusted. */
export const COACH_NUDGE_COMPLIANCE_MIN_DOSES = 5;
/** BP trigger: minimum systolic readings in the 7-day window. */
export const COACH_NUDGE_BP_MIN_READINGS = 3;
/** Score trigger: minimum recovery-score points the weekly mean must drop. */
export const COACH_NUDGE_SCORE_DROP = 15;
/** Score trigger: minimum samples per weekly window. */
export const COACH_NUDGE_SCORE_MIN_SAMPLES = 3;

export type CoachNudgeTrigger = "compliance" | "bp" | "score";

export interface CoachNudgeSummary {
  candidatesScanned: number;
  dispatched: number;
  skippedOptedOut: number;
  skippedNoProvider: number;
  skippedRecentNudge: number;
  skippedNoTrigger: number;
  skippedNoChannel: number;
  failed: number;
}

function resolveLocale(locale: string | null | undefined): Locale {
  return locales.includes(locale as Locale)
    ? (locale as Locale)
    : defaultLocale;
}

/**
 * Pure trigger predicates — exported for the unit tests so the
 * thresholds stay pinned without a DB.
 */
export function evaluateComplianceTrigger(
  rows: { takenAt: Date | null; skipped: boolean }[],
): boolean {
  // Deliberate skips are a planned break, not a compliance problem —
  // exclude them from both numerator and denominator (the compliance
  // engine's own semantics).
  const due = rows.filter((r) => !r.skipped);
  if (due.length < COACH_NUDGE_COMPLIANCE_MIN_DOSES) return false;
  const taken = due.filter((r) => r.takenAt !== null).length;
  return taken / due.length < COACH_NUDGE_COMPLIANCE_THRESHOLD;
}

export function evaluateBpTrigger(
  systolicValues: number[],
  greenMax: number | null,
): boolean {
  if (greenMax === null) return false;
  if (systolicValues.length < COACH_NUDGE_BP_MIN_READINGS) return false;
  const mean =
    systolicValues.reduce((sum, v) => sum + v, 0) / systolicValues.length;
  return mean > greenMax;
}

export function evaluateScoreTrigger(
  recentValues: number[],
  priorValues: number[],
): boolean {
  if (
    recentValues.length < COACH_NUDGE_SCORE_MIN_SAMPLES ||
    priorValues.length < COACH_NUDGE_SCORE_MIN_SAMPLES
  ) {
    return false;
  }
  const mean = (values: number[]) =>
    values.reduce((sum, v) => sum + v, 0) / values.length;
  return mean(priorValues) - mean(recentValues) >= COACH_NUDGE_SCORE_DROP;
}

/**
 * Build the localised push payload for a trigger. Bodies stay
 * deliberately vague on numbers — a lock screen is not the place for
 * health figures; the Coach conversation carries the detail.
 */
export function buildCoachNudgePayload(
  trigger: CoachNudgeTrigger,
  locale: string | null | undefined,
): { title: string; body: string } {
  const t = getServerTranslator(resolveLocale(locale)).t;
  switch (trigger) {
    case "compliance":
      return {
        title: t("coachNudges.complianceTitle"),
        body: t("coachNudges.complianceBody"),
      };
    case "bp":
      return {
        title: t("coachNudges.bpTitle"),
        body: t("coachNudges.bpBody"),
      };
    case "score":
      return {
        title: t("coachNudges.scoreTitle"),
        body: t("coachNudges.scoreBody"),
      };
  }
}

/**
 * Evaluate the triggers for one user. Exported for tests; the tick
 * below feeds it the pre-fetched rows.
 */
export async function findTriggerForUser(
  prisma: PrismaClient,
  user: {
    id: string;
    heightCm: number | null;
    dateOfBirth: Date | null;
    gender: string | null;
    thresholdsJson: unknown;
  },
  now: Date,
): Promise<CoachNudgeTrigger | null> {
  const sevenDaysAgo = new Date(now.getTime() - 7 * MS_PER_DAY);
  const fourteenDaysAgo = new Date(now.getTime() - 14 * MS_PER_DAY);

  // 1) Medication compliance (7 d).
  const intakeRows = await prisma.medicationIntakeEvent.findMany({
    where: {
      userId: user.id,
      deletedAt: null,
      scheduledFor: { gte: sevenDaysAgo, lte: now },
    },
    select: { takenAt: true, skipped: true },
  });
  if (evaluateComplianceTrigger(intakeRows)) return "compliance";

  // 2) Systolic weekly mean vs the user's effective target.
  const systolic = await prisma.measurement.findMany({
    where: {
      userId: user.id,
      type: "BLOOD_PRESSURE_SYS",
      deletedAt: null,
      measuredAt: { gte: sevenDaysAgo, lte: now },
    },
    select: { value: true },
  });
  if (systolic.length >= COACH_NUDGE_BP_MIN_READINGS) {
    const range = getEffectiveRange(
      "BLOOD_PRESSURE_SYS",
      {
        heightCm: user.heightCm,
        dateOfBirth: user.dateOfBirth,
        gender: user.gender,
      },
      (user.thresholdsJson ?? null) as ThresholdOverridesJson | null,
    );
    if (
      evaluateBpTrigger(
        systolic.map((m) => m.value),
        range.range?.greenMax ?? null,
      )
    ) {
      return "bp";
    }
  }

  // 3) Recovery score falling sharply week-over-week.
  const scores = await prisma.measurement.findMany({
    where: {
      userId: user.id,
      type: "RECOVERY_SCORE",
      deletedAt: null,
      measuredAt: { gte: fourteenDaysAgo, lte: now },
    },
    select: { value: true, measuredAt: true },
  });
  const recent = scores
    .filter((m) => m.measuredAt >= sevenDaysAgo)
    .map((m) => m.value);
  const prior = scores
    .filter((m) => m.measuredAt < sevenDaysAgo)
    .map((m) => m.value);
  if (evaluateScoreTrigger(recent, prior)) return "score";

  return null;
}

/**
 * Run one coach-nudge cron tick. Per-user work is wrapped in its own
 * try/catch so a single bad row cannot abort the rest of the pass.
 */
export async function runCoachNudgeTick(
  prisma: PrismaClient,
  now: Date,
  options: {
    dispatch?: typeof dispatchNotification;
  } = {},
): Promise<CoachNudgeSummary> {
  const dispatchImpl = options.dispatch ?? dispatchNotification;

  const summary: CoachNudgeSummary = {
    candidatesScanned: 0,
    dispatched: 0,
    skippedOptedOut: 0,
    skippedNoProvider: 0,
    skippedRecentNudge: 0,
    skippedNoTrigger: 0,
    skippedNoChannel: 0,
    failed: 0,
  };

  // Gate 1 — operator kill-switch (master assistant switch included).
  const flags = await getAssistantFlags();
  if (!flags.coach) return summary;

  // Gate 2 — per-user Coach opt-out, plus the credential-presence
  // columns gate 3 needs (evaluated locally, never decrypted).
  const users = await prisma.user.findMany({
    where: { disableCoach: false },
    select: {
      id: true,
      locale: true,
      notificationPrefs: true,
      heightCm: true,
      dateOfBirth: true,
      gender: true,
      thresholdsJson: true,
      aiProvider: true,
      aiProviderChain: true,
      aiAnthropicKeyEncrypted: true,
      aiLocalKeyEncrypted: true,
      aiOpenaiKeyEncrypted: true,
      aiBaseUrl: true,
      codexConnectionStatus: true,
      codexAccessTokenEncrypted: true,
      codexRefreshTokenEncrypted: true,
    },
  });
  if (users.length === 0) return summary;

  const settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
    select: { adminAiKeyEncrypted: true },
  });
  const adminKeyConfigured = !!settings?.adminAiKeyEncrypted;

  const capCutoff = new Date(
    now.getTime() - COACH_NUDGE_MIN_INTERVAL_DAYS * MS_PER_DAY,
  );

  for (const user of users) {
    summary.candidatesScanned += 1;
    try {
      // Gate 4 — per-user opt-out.
      if (!resolveCoachNudgesEnabled(user.notificationPrefs)) {
        summary.skippedOptedOut += 1;
        continue;
      }

      // Gate 3 — a Coach without a provider cannot answer the nudge.
      if (!userRowHasProviderCredential(user, adminKeyConfigured)) {
        summary.skippedNoProvider += 1;
        continue;
      }

      // Gate 5 — one nudge per rolling week, anchored on the
      // push-attempts ledger. A delivered nudge writes an `ok` row per
      // succeeding channel; a fully failed dispatch leaves the slot
      // free so tomorrow's tick can retry.
      const recentNudge = await prisma.pushAttempt.findFirst({
        where: {
          userId: user.id,
          eventType: "COACH_NUDGE",
          result: "ok",
          createdAt: { gte: capCutoff },
        },
        select: { id: true },
      });
      if (recentNudge) {
        summary.skippedRecentNudge += 1;
        continue;
      }

      const trigger = await findTriggerForUser(prisma, user, now);
      if (!trigger) {
        summary.skippedNoTrigger += 1;
        continue;
      }

      const { title, body } = buildCoachNudgePayload(trigger, user.locale);
      const outcome = await dispatchImpl({
        eventType: "COACH_NUDGE",
        userId: user.id,
        title,
        message: body,
        metadata: {
          scheduledAt: now.toISOString(),
          trigger,
          // Deep link — the web-push sender threads this into the
          // service-worker payload's click target.
          url: "/insights/coach",
        },
      });

      if (!outcome.dispatched) {
        summary.skippedNoChannel += 1;
        continue;
      }
      summary.dispatched += 1;
    } catch (err: unknown) {
      summary.failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      getEvent()?.addWarning(
        `coach-nudge per-user pass failed for ${user.id}: ${message}`,
      );
    }
  }

  return summary;
}
