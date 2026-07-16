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
import {
  buildDailyDigest,
  type DailyDigest,
  type DailyDigestPreventiveDue,
  type DailyDigestScore,
  type DailyDigestSyncIssue,
} from "@/lib/daily/digest";

/** Integration states that mean "your action is needed to keep data flowing". */
const SYNC_ISSUE_STATES = ["error_reauth", "parked"] as const;

/** Defensive cap on how many overdue reminders we read for the rail summary. */
const PREVENTIVE_DUE_READ_LIMIT = 20;

function resolveLocale(locale: string | null | undefined): Locale {
  return locales.includes(locale as Locale)
    ? (locale as Locale)
    : defaultLocale;
}

export async function loadDailyDigest(
  user: User,
  now: Date = new Date(),
): Promise<DailyDigest> {
  const [{ body: snapshot, locale }, modules, syncRows, dueReminders] =
    await Promise.all([
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
    },
  });

  return digest;
}
