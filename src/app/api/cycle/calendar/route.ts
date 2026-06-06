/**
 * `GET /api/cycle/calendar?from&to` — predicted calendar read
 * (ios-contract §2.D).
 *
 * Calls the pure engine (`predictCycle` + per-day phase) to build
 * `{ profile, prediction, days }`. The synchronous engine call is cheap
 * (pure stats); the heavy part is the cache persist, which is debounced
 * stale-while-revalidate and fire-and-forget so it never blocks the GET.
 * Fertile-window fields are goal-gated (null unless TRYING_TO_CONCEIVE),
 * suppressed server-side.
 *
 * Default range: current cycle − 90d … +180d forward.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiError, apiSuccess } from "@/lib/api-response";
import { requireCycleEnabled } from "@/lib/cycle/gate";
import { cycleCalendarQuerySchema } from "@/lib/validations/cycle";
import {
  buildCalendar,
  type CalendarDayLogRow,
} from "@/lib/cycle/engine-adapter";
import {
  toCyclePredictionDTO,
  goalAllowsFertileWindow,
} from "@/lib/cycle/dto";
import { persistPredictionCache } from "@/lib/cycle/prediction-cache";
import { addDays, dayDiff } from "@/lib/cycle/day-math";
import { BBT_WINDOW } from "@/lib/cycle/types";
import { DEFAULT_TIMEZONE, moodDateKey } from "@/lib/mood/date-key";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { resolveServerLocale } from "@/lib/i18n/server-locale";

const DEFAULT_PAST_DAYS = 90;
const DEFAULT_FORWARD_DAYS = 180;
/** Hard cap on the rendered span (days) to bound the day-grid build. */
const MAX_SPAN_DAYS = 400;

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const gate = await requireCycleEnabled(user.id, user.gender);
  if (!gate.enabled) return gate.response;
  const profile = gate.profile;

  const url = new URL(request.url);
  const parsed = cycleCalendarQuerySchema.safeParse({
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
  });
  if (!parsed.success) {
    return apiError("Invalid calendar query", 422, {
      errorCode: "cycle.calendar.invalid",
    });
  }

  const tz = user.timezone ?? DEFAULT_TIMEZONE;
  const today = moodDateKey(new Date(), tz);
  const from = parsed.data.from ?? addDays(today, -DEFAULT_PAST_DAYS);
  const to = parsed.data.to ?? addDays(today, DEFAULT_FORWARD_DAYS);

  // Reject an inverted or absurdly wide range up front.
  const fromMs = Date.parse(`${from}T12:00:00Z`);
  const toMs = Date.parse(`${to}T12:00:00Z`);
  if (toMs < fromMs || (toMs - fromMs) / 86_400_000 > MAX_SPAN_DAYS) {
    return apiError("Calendar range too wide or inverted", 422, {
      errorCode: "cycle.calendar.range",
    });
  }

  const [cycles, dayLogRows, nightlyTemps] = await Promise.all([
    prisma.menstrualCycle.findMany({
      where: { userId: user.id, deletedAt: null },
      orderBy: { startDate: "asc" },
    }),
    // Bound the day-log read to the rendered span plus the symptothermal
    // lookback — the earlier of `from` and (today − BBT_WINDOW). Cycle-length
    // stats run off MenstrualCycle rows, so day-logs can be windowed (QA: perf
    // — unbounded full-history read on a hot, per-navigation route).
    prisma.cycleDayLog.findMany({
      where: {
        userId: user.id,
        deletedAt: null,
        date: {
          gte:
            dayDiff(from, addDays(today, -BBT_WINDOW)) <= 0
              ? from
              : addDays(today, -BBT_WINDOW),
        },
      },
      orderBy: { date: "asc" },
      select: {
        date: true,
        flow: true,
        basalBodyTempC: true,
        ovulationTest: true,
        cervicalMucus: true,
        _count: { select: { symptomLinks: true } },
      },
    }),
    // Apple Watch wrist/skin temperature feeds the temperature-trend
    // ovulation layer. Read the WRIST_TEMPERATURE measurements as nightly
    // values; the engine derives the trailing-mean deviation itself.
    prisma.measurement.findMany({
      where: {
        userId: user.id,
        deletedAt: null,
        type: "WRIST_TEMPERATURE",
        measuredAt: {
          gte: new Date(Date.parse(`${addDays(today, -90)}T00:00:00Z`)),
        },
      },
      orderBy: { measuredAt: "asc" },
      select: { measuredAt: true, value: true },
    }),
  ]);

  const dayLogs: CalendarDayLogRow[] = dayLogRows.map((l) => ({
    date: l.date,
    flow: l.flow,
    basalBodyTempC: l.basalBodyTempC,
    ovulationTest: l.ovulationTest,
    cervicalMucus: l.cervicalMucus,
    hasSymptoms: l._count.symptomLinks > 0,
  }));

  const nights = nightlyTemps.map((m) => ({
    date: moodDateKey(m.measuredAt, tz),
    valueC: m.value,
  }));

  const goalAllowsFertile = goalAllowsFertileWindow(profile.goal);

  const { prediction, days } = buildCalendar(
    profile,
    cycles,
    dayLogs,
    nights,
    from,
    to,
    today,
    goalAllowsFertile,
  );

  // Persist the cache fire-and-forget (debounced) — never block the read.
  let generatedAt = new Date().toISOString();
  if (prediction) {
    const now = new Date();
    generatedAt = now.toISOString();
    void persistPredictionCache(user.id, prediction, now);
  }

  const locale = await resolveServerLocale({
    request,
    userLocale: user.locale ?? undefined,
  });
  const t = getServerTranslator(locale);
  const disclaimer = t.t("cycle.prediction.disclaimer");

  annotate({
    action: { name: "cycle.calendar.read" },
    meta: {
      days: days.length,
      cycles_observed: prediction?.cyclesObserved ?? 0,
      has_prediction: prediction !== null,
    },
  });

  return apiSuccess({
    profile: {
      goal: profile.goal,
      rawChartMode: profile.rawChartMode,
      predictionEnabled: profile.predictionEnabled,
      cyclesObserved: prediction?.cyclesObserved ?? cycles.length,
    },
    prediction: prediction
      ? toCyclePredictionDTO(prediction, goalAllowsFertile, disclaimer)
      : null,
    days,
    meta: { generatedAt },
  });
});
