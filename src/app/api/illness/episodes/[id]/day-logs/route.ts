/**
 * `GET  /api/illness/episodes/{id}/day-logs?date=YYYY-MM-DD` — the one
 *        day-log for the episode + day, or `null` when nothing is logged
 *        (lets the log-day sheet pre-fill).
 * `POST /api/illness/episodes/{id}/day-logs` — upsert the day's symptom /
 *        functional-impact / fever timeline row. Upserts on
 *        `(episodeId, date)`: 201 on insert, 200 on update.
 *
 * Born-gated + owner-scoped (the episode must be owned + live). `note` is
 * encrypted at rest; `userId` is narrowed from auth, never a body field.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { requireIllnessEnabled } from "@/lib/illness/gate";
import {
  illnessDayLogInputSchema,
  illnessDayLogQuerySchema,
} from "@/lib/validations/illness";
import { upsertIllnessDayLog } from "@/lib/illness/day-log-write";
import { toIllnessDayLogDTO, dayLogSymptomInclude } from "@/lib/illness/dto";
import { DEFAULT_TIMEZONE } from "@/lib/mood/date-key";

type RouteParams = { params: Promise<{ id: string }> };

/** Resolve the episode, 404ing unless it is owned + live. */
async function loadOwnedEpisode(
  episodeId: string,
  userId: string,
): Promise<{ ok: true } | { ok: false; response: Response }> {
  const episode = await prisma.illnessEpisode.findUnique({
    where: { id: episodeId },
    select: { userId: true, deletedAt: true },
  });
  if (!episode || episode.userId !== userId || episode.deletedAt !== null) {
    return { ok: false, response: apiError("Episode not found", 404) };
  }
  return { ok: true };
}

export const GET = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const gate = await requireIllnessEnabled(user.id);
    if (!gate.enabled) return gate.response;

    const { id } = await params;
    const owned = await loadOwnedEpisode(id, user.id);
    if (!owned.ok) return owned.response;

    const parsed = illnessDayLogQuerySchema.safeParse({
      date: new URL(request.url).searchParams.get("date"),
    });
    if (!parsed.success) {
      return returnAllZodIssues(parsed.error, 422, {
        errorCode: "illness.day-log.invalid",
      });
    }

    const row = await prisma.illnessDayLog.findFirst({
      where: { episodeId: id, date: parsed.data.date, deletedAt: null },
      include: dayLogSymptomInclude,
    });

    annotate({
      action: {
        name: "illness.day-log.read",
        entity_type: "illness_day_log",
      },
      meta: { found: row !== null },
    });

    return apiSuccess(row ? toIllnessDayLogDTO(row) : null);
  },
);

export const POST = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const gate = await requireIllnessEnabled(user.id);
    if (!gate.enabled) return gate.response;

    const { id } = await params;
    const owned = await loadOwnedEpisode(id, user.id);
    if (!owned.ok) return owned.response;

    const { data: rawBody, error: jsonError } = await safeJson(request, {
      maxBytes: 16 * 1024,
    });
    if (jsonError) return jsonError;

    const parsed = illnessDayLogInputSchema.safeParse(rawBody);
    if (!parsed.success) {
      annotate({
        action: { name: "illness.day-log.validation-failed" },
        meta: { issue_count: parsed.error.issues.length },
      });
      return returnAllZodIssues(parsed.error, 422, {
        errorCode: "illness.day-log.invalid",
      });
    }

    const tz = user.timezone ?? DEFAULT_TIMEZONE;
    const result = await upsertIllnessDayLog(user.id, id, parsed.data, tz);

    await auditLog("illness.day-log.upsert", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { dayLogId: result.id, episodeId: id, existed: result.existed },
    });

    annotate({
      action: {
        name: "illness.day-log.upsert",
        entity_type: "illness_day_log",
        entity_id: result.id,
      },
      meta: { existed: result.existed },
    });

    return apiSuccess(result.dto, result.existed ? 200 : 201);
  },
);
