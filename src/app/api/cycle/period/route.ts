/**
 * `POST /api/cycle/period` — one-tap period-boundary shortcut
 * (ios-contract §2.C).
 *
 * `action:"start"` opens a new `MenstrualCycle` anchored at `date`,
 * closes the prior open cycle (endDate = day before, lengthDays set),
 * and writes the boundary `CycleDayLog(flow=MEDIUM)`. `action:"end"`
 * stamps the current cycle's `periodEndDate` and writes the boundary
 * day-log. Convenience over §2.A; returns
 * `{ cycle: MenstrualCycleDTO, dayLog: CycleDayLogDTO }`.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { requireCycleEnabled } from "@/lib/cycle/gate";
import { cyclePeriodSchema } from "@/lib/validations/cycle";
import { upsertCycleDayLog } from "@/lib/cycle/day-log-write";
import {
  toCycleDayLogDTO,
  toMenstrualCycleDTO,
  dayLogSymptomInclude,
} from "@/lib/cycle/dto";
import { DEFAULT_TIMEZONE } from "@/lib/mood/date-key";
import { addDays, dayDiff } from "@/lib/cycle/day-math";

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const gate = await requireCycleEnabled(user.id, user.gender);
  if (!gate.enabled) return gate.response;

  const { data: rawBody, error: jsonError } = await safeJson(request);
  if (jsonError) return jsonError;

  const parsed = cyclePeriodSchema.safeParse(rawBody);
  if (!parsed.success) {
    annotate({
      action: { name: "cycle.period.validation-failed" },
      meta: { issue_count: parsed.error.issues.length },
    });
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "cycle.period.invalid",
    });
  }

  const { action, date, externalId, loggedAt } = parsed.data;
  const tz = user.timezone ?? DEFAULT_TIMEZONE;

  let cycleId: string;

  if (action === "start") {
    // Close the prior open cycle (its end is the day before this start)
    // and record its observed length.
    const prior = await prisma.menstrualCycle.findFirst({
      where: { userId: user.id, deletedAt: null, startDate: { lt: date } },
      orderBy: { startDate: "desc" },
      select: { id: true, startDate: true },
    });
    if (prior) {
      await prisma.menstrualCycle.update({
        where: { id: prior.id },
        data: {
          endDate: addDays(date, -1),
          lengthDays: dayDiff(date, prior.startDate),
          syncVersion: { increment: 1 },
        },
      });
    }

    // Upsert the new cycle on the `(userId, startDate)` unique so a
    // re-tap on the same day is idempotent.
    const cycle = await prisma.menstrualCycle.upsert({
      where: { userId_startDate: { userId: user.id, startDate: date } },
      create: { userId: user.id, startDate: date, tz, isPredicted: false },
      update: { deletedAt: null, isPredicted: false, syncVersion: { increment: 1 } },
    });
    cycleId = cycle.id;
  } else {
    // `end`: stamp the current cycle's periodEndDate.
    const current = await prisma.menstrualCycle.findFirst({
      where: { userId: user.id, deletedAt: null, startDate: { lte: date } },
      orderBy: { startDate: "desc" },
      select: { id: true },
    });
    if (!current) {
      return apiSuccessNoCycle();
    }
    await prisma.menstrualCycle.update({
      where: { id: current.id },
      data: { periodEndDate: date, syncVersion: { increment: 1 } },
    });
    cycleId = current.id;
  }

  // Boundary day-log. Start → MEDIUM flow opens the bleed; end → SPOTTING
  // tail (the last logged bleeding day).
  await upsertCycleDayLog(
    user.id,
    {
      date,
      flow: action === "start" ? "MEDIUM" : "SPOTTING",
      loggedAt,
      source: "MANUAL",
      ...(externalId ? { externalId } : {}),
    },
    tz,
    cycleId,
  );

  const [cycleRow, dayLogRow] = await Promise.all([
    prisma.menstrualCycle.findUniqueOrThrow({ where: { id: cycleId } }),
    prisma.cycleDayLog.findFirstOrThrow({
      where: { userId: user.id, date, deletedAt: null },
      include: dayLogSymptomInclude,
    }),
  ]);

  await auditLog("cycle.period.boundary", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { action, date, cycleId },
  });

  annotate({
    action: {
      name: "cycle.period.boundary",
      entity_type: "menstrual_cycle",
      entity_id: cycleId,
    },
    meta: { boundary: action },
  });

  return apiSuccess({
    cycle: toMenstrualCycleDTO(cycleRow),
    dayLog: toCycleDayLogDTO(dayLogRow),
  });
});

/** `end` with no preceding cycle is a no-op the client should not hit. */
function apiSuccessNoCycle(): Response {
  return apiSuccess({ cycle: null, dayLog: null });
}
