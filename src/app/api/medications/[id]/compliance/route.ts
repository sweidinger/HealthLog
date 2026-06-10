import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess, apiError } from "@/lib/api-response";
import {
  buildComplianceMedicationContext,
  buildMedicationComplianceBundle,
  lastNonSkippedTakenAt,
  type ComplianceDisplay,
  type ComplianceResult,
  type DailyComplianceEntry,
} from "@/lib/analytics/compliance";
import type { DoseHistoryRow } from "@/lib/medications/scheduling/dose-history";
import { assertMedicationOwnership } from "@/lib/medications/route-guards";
import { cached, caches, type ServerCache } from "@/lib/cache/server-cache";
import { checkRateLimit } from "@/lib/rate-limit";
import { userDayKey } from "@/lib/tz/format";

type RouteParams = { params: Promise<{ id: string }> };

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Lower bound for the intake-event read. The widest window any served
 * block needs is the 365-day display rung; one extra day absorbs the
 * inclusive-boundary edge so the ledger's own 365-day clamp never sits
 * on a half-fetched day.
 */
const EVENT_FETCH_WINDOW_DAYS = 366;

/** The cached response body (the exact public wire shape). */
interface CompliancePayload {
  compliance7: ComplianceResult;
  compliance30: ComplianceResult;
  dailyCompliance: Record<string, DailyComplianceEntry>;
  complianceDisplay: ComplianceDisplay;
}

/**
 * v1.15.18 — fold one dose-history ledger row into a per-day heatmap entry.
 *
 * Slot rows contribute to `expected` / `expectedCount` (the day's due-slot
 * count): a taken slot adds to `taken` and its timing bucket; a missed slot
 * stays uncounted in `taken`; a skipped slot lands in `skipped`; an upcoming
 * slot is still due but not yet acted on. An ad-hoc row is a real off-schedule
 * take — it counts as `taken` AND adds its own `expected` slot (so the
 * heatmap's `missed = expected − taken − skipped` math stays non-negative) and
 * reads on-time (a logged dose colours green).
 */
function bucketLedgerRow(
  entry: DailyComplianceEntry,
  row: DoseHistoryRow,
): void {
  switch (row.status) {
    case "taken_on_time":
      entry.expected++;
      entry.expectedCount++;
      entry.taken++;
      entry.onTime++;
      break;
    case "taken_late":
      entry.expected++;
      entry.expectedCount++;
      entry.taken++;
      entry.late++;
      break;
    case "missed":
      entry.expected++;
      entry.expectedCount++;
      break;
    case "skipped":
      entry.expected++;
      entry.expectedCount++;
      entry.skipped++;
      break;
    case "upcoming":
      // A future / still-takeable slot is due but not yet acted on. It counts
      // toward the day's expected/due grid but not toward taken or missed.
      entry.expected++;
      entry.expectedCount++;
      break;
    case "ad_hoc":
      // An off-schedule take: a real taken dose with no scheduled slot. Count
      // it as taken + its own expected slot so the heatmap missed math holds.
      entry.expected++;
      entry.expectedCount++;
      entry.taken++;
      entry.onTime++;
      break;
  }
}

/**
 * The full compliance computation for one medication. Lifted out of the
 * handler so the server cache can wrap it: ONE bounded intake-event read
 * (only the four columns the math consumes, floored at the 366-day fetch
 * window) feeds ONE shared band-expansion pass
 * (`buildMedicationComplianceBundle`) that serves the 7-/30-day blocks,
 * the cadence-scaled display rows AND the 90-day heatmap — replacing the
 * historical five-plus per-request expansions over an unbounded,
 * all-columns event read.
 */
async function buildCompliancePayload(
  medication: {
    id: string;
    createdAt: Date;
    startsOn: Date | null;
    endsOn: Date | null;
    oneShot: boolean;
    schedules: Parameters<typeof buildMedicationComplianceBundle>[1];
  },
  userId: string,
  userTz: string,
): Promise<CompliancePayload> {
  // v1.15.9 — pin a single `now` and thread it into every cadence
  // computation so no block can straddle a day boundary on a slow request.
  const now = new Date();
  const createdAt = medication.createdAt;

  const fetchFrom = new Date(
    Math.max(
      createdAt.getTime(),
      now.getTime() - EVENT_FETCH_WINDOW_DAYS * DAY_MS,
    ),
  );
  const events = await prisma.medicationIntakeEvent.findMany({
    // v1.7.0 sync — exclude tombstoned rows from the compliance read.
    // Bounded to the 366-day fetch window: every served block is a suffix
    // of the 365-day ledger window, so older rows can never change the
    // response.
    where: {
      medicationId: medication.id,
      userId,
      deletedAt: null,
      scheduledFor: { gte: fetchFrom },
    },
    orderBy: { scheduledFor: "desc" },
    select: {
      takenAt: true,
      skipped: true,
      scheduledFor: true,
      // v1.15.9 — a forgotten dose the auto-miss cron flipped counts as a
      // miss, not a neutral skip.
      autoMissed: true,
      // v1.15.20 — pinned takes bind by anchor in the unified ledger so the
      // % agrees with the history view on a "zugeordnet" dose (taken-late).
      attributionSource: true,
    },
  });

  // v1.7.0 SB-SCHED-2 — thread the medication context so the denominator
  // routes through the canonical engine (RRULE / rolling / one-shot / PRN /
  // cyclic). `lastIntakeAt` is the latest non-skipped takenAt inside the
  // fetch window (rolling cadences re-anchor on it).
  const lastIntakeAt = lastNonSkippedTakenAt(events);
  const medicationContext = buildComplianceMedicationContext(
    medication,
    lastIntakeAt,
    userTz,
  );

  // ONE shared expansion pass for every served block (the v1.15.20
  // performance fix): bands + ledger + timeline are minted once over the
  // widest window and each sub-window is a tally over the same rows.
  const bundle = buildMedicationComplianceBundle(
    events,
    medication.schedules,
    medicationContext,
    now,
  );

  // v1.15.18 — the heatmap / line-chart daily map is bucketed from the ONE
  // unified dose-history ledger (the same bands the % + the history view
  // read), so the per-day timing split (on-time / late) and the per-day
  // missed marks can never disagree with the headline rate. The 90-day
  // window is carved out of the shared ledger by `row.at`; the window
  // floor clamps to the medication's creation so pre-existence days never
  // mint phantom slots.
  const heatmapFrom = new Date(
    Math.max(now.getTime() - 90 * DAY_MS, createdAt.getTime()),
  );

  const dailyCompliance: Record<string, DailyComplianceEntry> = {};
  const byDay = new Map<string, DailyComplianceEntry>();
  const ensureDay = (key: string): DailyComplianceEntry => {
    let entry = byDay.get(key);
    if (!entry) {
      entry = {
        expected: 0,
        expectedCount: 0,
        due: false,
        taken: 0,
        skipped: 0,
        onTime: 0,
        late: 0,
        veryLate: 0,
        early: 0,
      };
      byDay.set(key, entry);
    }
    return entry;
  };

  // Bucket each ledger row into its user-tz day. A slot row buckets on its
  // anchor; an ad-hoc row on its real take time.
  for (const row of bundle.ledgerRows) {
    if (row.at.getTime() < heatmapFrom.getTime()) continue;
    const key = userDayKey(row.at, userTz);
    const entry = ensureDay(key);
    bucketLedgerRow(entry, row);
  }

  for (const [key, entry] of byDay) {
    entry.due = entry.expectedCount > 0;
    dailyCompliance[key] = entry;
  }

  return {
    compliance7: bundle.compliance7,
    compliance30: bundle.compliance30,
    dailyCompliance,
    complianceDisplay: bundle.complianceDisplay,
  };
}

export const GET = apiHandler(
  async (_request: Request, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const { id } = await params;

    // The medications list fans this endpoint out once per card, so the
    // per-user budget is generous — it only caps a runaway client loop.
    const rl = await checkRateLimit(
      `medication-compliance:${user.id}`,
      60,
      60_000,
    );
    if (!rl.allowed) {
      return apiError("Too many compliance requests. Please retry later.", 429);
    }

    // v1.4.25 W21 Fix-N — privacy gate hoisted to the shared helper.
    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;

    const medication = await prisma.medication.findUnique({
      where: { id },
      include: {
        schedules: true,
        // v1.16.3 — archived schedule eras for era-aware compliance.
        scheduleRevisions: { orderBy: { validFrom: "asc" } },
      },
    });

    if (!medication) {
      return apiError("Medication not found", 404);
    }

    const userTz = user.timezone || "Europe/Berlin";

    // Read-through the per-user compliance cache (15 min TTL). Every
    // intake / medication write flushes the `${userId}|` prefix via
    // `invalidateUserMedications`, so a warm entry can only be stale
    // relative to wall-clock drift, never to a user action. The key
    // carries the timezone the payload was bucketed in: day keys, the
    // heatmap, and the overdue cut all derive from `userTz`, so a
    // timezone change must miss the old entry instead of serving day
    // buckets computed for the previous zone until the TTL lapses.
    const payload = await cached(
      caches.medicationCompliance as ServerCache<CompliancePayload>,
      `${user.id}|${id}|compliance|${userTz}`,
      () => buildCompliancePayload(medication, user.id, userTz),
      annotate,
    );

    annotate({
      action: {
        name: "medication.compliance",
        entity_type: "medication",
        entity_id: id,
      },
      meta: {
        compliance7: payload.compliance7.rate,
        compliance30: payload.compliance30.rate,
        complianceShortDays: payload.complianceDisplay.shortDays,
        complianceLongDays: payload.complianceDisplay.longDays,
      },
    });

    return apiSuccess(payload);
  },
);
