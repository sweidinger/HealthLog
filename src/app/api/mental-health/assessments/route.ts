/**
 * v1.25 — opt-in mental-health screener assessments (PHQ-9 / GAD-7).
 *
 * POST records one completed administration: the per-item answers are encrypted
 * into a single AES-256-GCM Bytes blob (never logged, never returned by
 * default), and the server-authoritative total + severity band + item-9 safety
 * flag are denormalised for cheap history reads. A matching PHQ9_SCORE /
 * GAD7_SCORE Measurement row is written so the score trend rides the existing
 * chart/rollup infra — the trend, never the item content.
 *
 * SAFETY: on any non-zero PHQ-9 item 9, the response carries the calm,
 * locale-aware crisis-resource set and stamps `crisisShownAt`. No clinical
 * interpretation, no AI ingestion of item content, no third-party alerting.
 *
 * GET lists the caller's assessments (totals + bands + flags only — item-level
 * answers are excluded from this surface by construction).
 */
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiSuccess,
  returnAllZodIssues,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import {
  createAssessmentSchema,
  listAssessmentsSchema,
} from "@/lib/validations/mental-health";
import {
  INSTRUMENTS,
  INSTRUMENT_MEASUREMENT_TYPE,
  isSafetyFlagged,
  scoreTotal,
  severityBand,
  type InstrumentId,
} from "@/lib/mental-health/instruments";
import { crisisResourcesForLocale } from "@/lib/mental-health/crisis-resources";
import type { MeasurementType, MeasurementSource } from "@/generated/prisma/client";

function shapeRow(row: {
  id: string;
  instrument: string;
  locale: string;
  version: string;
  totalScore: number;
  severityBand: string;
  item9Flagged: boolean;
  crisisShownAt: Date | null;
  takenAt: Date;
  createdAt: Date;
}) {
  return {
    id: row.id,
    instrument: row.instrument,
    locale: row.locale,
    version: row.version,
    totalScore: row.totalScore,
    severityBand: row.severityBand,
    item9Flagged: row.item9Flagged,
    crisisShownAt: row.crisisShownAt?.toISOString() ?? null,
    takenAt: row.takenAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  const params = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = listAssessmentsSchema.safeParse(params);
  if (!parsed.success) {
    annotate({
      action: { name: "mental-health.list.validation-failed" },
      meta: { issue_count: sanitiseZodIssues(parsed.error.issues).length },
    });
    return returnAllZodIssues(parsed.error, 422);
  }
  const { instrument, limit, offset } = parsed.data;
  const rows = await prisma.mentalHealthAssessment.findMany({
    where: { userId: user.id, deletedAt: null, ...(instrument ? { instrument } : {}) },
    orderBy: { takenAt: "desc" },
    take: limit ?? 100,
    skip: offset ?? 0,
    select: {
      id: true,
      instrument: true,
      locale: true,
      version: true,
      totalScore: true,
      severityBand: true,
      item9Flagged: true,
      crisisShownAt: true,
      takenAt: true,
      createdAt: true,
    },
  });
  annotate({
    action: { name: "mental-health.list" },
    meta: { count: rows.length },
  });
  return apiSuccess({ assessments: rows.map(shapeRow) });
});

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  const body = await safeJson(request);
  const parsed = createAssessmentSchema.safeParse(body);
  if (!parsed.success) {
    annotate({
      action: { name: "mental-health.create.validation-failed" },
      meta: { issue_count: sanitiseZodIssues(parsed.error.issues).length },
    });
    return returnAllZodIssues(parsed.error, 422);
  }

  const { instrument, items, functionalDifficulty, takenAt, tz, locale } =
    parsed.data;
  const id = instrument as InstrumentId;
  const def = INSTRUMENTS[id];

  // Server-authoritative scoring (the client never computes these).
  const total = scoreTotal(items);
  const band = severityBand(id, total);
  const flagged = isSafetyFlagged(id, items);
  const presentedLocale = locale ?? user.locale ?? "en";
  const when = takenAt ? new Date(takenAt) : new Date();

  // Encrypt the per-item answers + the (unscored) functional-impairment follow-up.
  const blob = encryptToBytes(
    JSON.stringify({
      items,
      ...(functionalDifficulty !== undefined ? { functionalDifficulty } : {}),
      schema: 1,
    }),
  );

  const assessment = await prisma.mentalHealthAssessment.create({
    data: {
      userId: user.id,
      instrument: id,
      locale: presentedLocale,
      version: "standard",
      responsesEncrypted: blob,
      totalScore: total,
      severityBand: band,
      item9Flagged: flagged,
      crisisShownAt: flagged ? new Date() : null,
      takenAt: when,
      tz: tz ?? null,
      source: "WEB",
    },
    select: {
      id: true,
      instrument: true,
      locale: true,
      version: true,
      totalScore: true,
      severityBand: true,
      item9Flagged: true,
      crisisShownAt: true,
      takenAt: true,
      createdAt: true,
    },
  });

  // Read-optimised projection: the total rides a Measurement row so the existing
  // chart/rollup infra reads the trend without ever touching item content.
  await prisma.measurement.create({
    data: {
      userId: user.id,
      type: INSTRUMENT_MEASUREMENT_TYPE[id] as MeasurementType,
      value: total,
      unit: "score",
      source: "MANUAL" as MeasurementSource,
      measuredAt: when,
      notes: null,
      externalId: `assessment:${assessment.id}`,
    },
  });

  await auditLog("mental-health.create", {
    userId: user.id,
    // The score band is non-sensitive; item answers are NEVER logged.
    details: { instrument: id, severityBand: band },
  });
  annotate({
    action: { name: "mental-health.create" },
    meta: { instrument: id, item9_flagged: flagged },
  });

  // SAFETY: surface the locale-aware crisis resources on a positive item-9.
  const crisis = flagged ? crisisResourcesForLocale(presentedLocale) : null;

  return apiSuccess(
    {
      assessment: shapeRow(assessment),
      actionThreshold: def.actionThreshold,
      crisis,
    },
    201,
  );
});
