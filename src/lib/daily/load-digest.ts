/**
 * IO seam for the daily digest (P3) — gathers the ALREADY-CACHED inputs and
 * hands them to the pure `buildDailyDigest` composer.
 *
 * The heavy read (health score, meds-today, sleep last-seen, the daily
 * briefing lift) rides `readDashboardSnapshotCached` — the SAME SWR cell the
 * dashboard already serves, so the digest never re-runs the snapshot builder
 * within its TTL and never reaches an AI provider (the briefing is lifted
 * read-only from `User.insightsCachedText`). Two light deterministic reads add
 * the rail's non-snapshot inputs: broken integrations and overdue Vorsorge
 * reminders. Module gating is inherited from the snapshot (already
 * module-gated at the build layer) plus the resolved module map the item
 * builders consult.
 */
import type { User } from "@/generated/prisma/client";

import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { resolveModuleMap } from "@/lib/modules/gate";
import { readDashboardSnapshotCached } from "@/lib/dashboard/snapshot-read";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { defaultLocale, locales, type Locale } from "@/lib/i18n/config";
import { decryptFromBytes } from "@/lib/ai/coach/bytes-codec";
import {
  buildDailyDigest,
  type DailyDigest,
  type DailyDigestCoachPlan,
  type DailyDigestPreventiveDue,
  type DailyDigestScore,
  type DailyDigestSyncIssue,
} from "@/lib/daily/digest";

/** Integration states that mean "your action is needed to keep data flowing". */
const SYNC_ISSUE_STATES = ["error_reauth", "parked"] as const;

/** Defensive cap on how many overdue reminders we read for the rail summary. */
const PREVENTIVE_DUE_READ_LIMIT = 20;

/** Standing plan states that can carry a check-in (§2.3). */
const CHECKIN_PLAN_STATES = ["active", "reviewed"] as const;

/** Cap on plans scanned for the (one/day) check-in candidate. */
const CHECKIN_PLAN_READ_LIMIT = 50;

interface CoachPlanRow {
  id: string;
  status: string;
  reviewDate: Date | null;
  createdAt: Date;
  updatedAt: Date;
  ifCueEncrypted: Uint8Array;
  thenActionEncrypted: Uint8Array;
}

/**
 * Decrypt a plan's if→then prose fault-isolated (an undecryptable row keeps a
 * null text, never throws) so the check-in card can echo the user's own words.
 */
function toCoachPlanCandidate(row: CoachPlanRow): DailyDigestCoachPlan {
  let planText: string | null = null;
  try {
    planText = `${decryptFromBytes(row.ifCueEncrypted)} → ${decryptFromBytes(
      row.thenActionEncrypted,
    )}`;
  } catch {
    planText = null;
  }
  return {
    id: row.id,
    status: row.status,
    reviewDate: row.reviewDate,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    planText,
  };
}

function resolveLocale(locale: string | null | undefined): Locale {
  return locales.includes(locale as Locale)
    ? (locale as Locale)
    : defaultLocale;
}

export async function loadDailyDigest(
  user: User,
  now: Date = new Date(),
): Promise<DailyDigest> {
  const [
    { body: snapshot, locale },
    modules,
    syncRows,
    dueReminders,
    planRows,
  ] = await Promise.all([
    readDashboardSnapshotCached(user),
    resolveModuleMap(user.id),
    prisma.integrationStatus.findMany({
      where: { userId: user.id, state: { in: [...SYNC_ISSUE_STATES] } },
      select: { integration: true, state: true },
      orderBy: { integration: "asc" },
    }),
    prisma.measurementReminder.findMany({
      where: {
        userId: user.id,
        enabled: true,
        deletedAt: null,
        nextDueAt: { not: null, lte: now },
      },
      select: { label: true },
      orderBy: { nextDueAt: "asc" },
      take: PREVENTIVE_DUE_READ_LIMIT,
    }),
    // Standing plans for the (one/day) check-in candidate. The plaintext
    // columns decide due-ness; the encrypted prose is only decrypted below,
    // and only for a coach-enabled account (disabled-module data never
    // enters the digest — the builder also drops it, this skips the decrypt).
    prisma.coachPlan.findMany({
      where: {
        userId: user.id,
        deletedAt: null,
        status: { in: [...CHECKIN_PLAN_STATES] },
      },
      select: {
        id: true,
        status: true,
        reviewDate: true,
        createdAt: true,
        updatedAt: true,
        ifCueEncrypted: true,
        thenActionEncrypted: true,
      },
      orderBy: { updatedAt: "desc" },
      take: CHECKIN_PLAN_READ_LIMIT,
    }),
  ]);

  const score: DailyDigestScore | null = snapshot.healthScore
    ? {
        value: snapshot.healthScore.score,
        band: snapshot.healthScore.band,
        delta: snapshot.healthScore.delta,
      }
    : null;

  const sleepSlot = snapshot.tiles.lastSeenByType["SLEEP_DURATION"];
  const sleepLastSeenDaysAgo = sleepSlot ? sleepSlot.daysAgo : null;

  const syncIssues: DailyDigestSyncIssue[] = syncRows.map((row) => ({
    integration: row.integration,
    state: row.state,
  }));

  const preventiveDue: DailyDigestPreventiveDue[] = dueReminders.map((row) => ({
    label: row.label,
  }));

  // Only decrypt plan prose for a coach-enabled account; the builder gates on
  // the module too, so a disabled coach never surfaces a check-in either way.
  const coachEnabled = modules.coach !== false;
  const coachPlans: DailyDigestCoachPlan[] = coachEnabled
    ? planRows.map((row) => toCoachPlanCandidate(row as CoachPlanRow))
    : [];

  const { t } = getServerTranslator(resolveLocale(locale));

  const digest = buildDailyDigest(
    {
      now,
      modules,
      score,
      briefing: snapshot.briefing,
      medsToday: snapshot.medsToday,
      sleepLastSeenDaysAgo,
      syncIssues,
      preventiveDue,
      coachPlans,
    },
    t,
  );

  annotate({
    action: { name: "daily.digest.build" },
    meta: {
      daily_digest_phase: digest.phase,
      daily_digest_sleep_pending: digest.sleepPending,
      daily_digest_item_count: digest.worthALook.length,
      daily_digest_has_score: digest.score !== null,
      daily_digest_has_checkin: digest.worthALook.some(
        (i) => i.kind === "coach_checkin",
      ),
    },
  });

  return digest;
}
