/**
 * `POST /api/cycle/day-logs` — single cycle day-log capture
 * (ios-contract §2.A).
 *
 * Upserts on `(userId, source, externalId)` when an `externalId` is
 * present (the cross-device dedup key), else the canonical `(userId,
 * date)` key. `note` is encrypted at rest (`notesEncrypted`); the intent
 * fields stay queryable plaintext (they feed the rollup / correlation
 * tier). Returns the full `CycleDayLogDTO`: 201 on insert, 200 on update.
 *
 * Gated: a disabled / non-FEMALE-without-opt-in account 403s with
 * `errorCode:"cycle.disabled"` even with a valid Bearer token.
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
import { withIdempotency } from "@/lib/idempotency";
import { requireCycleEnabled } from "@/lib/cycle/gate";
import { cycleDayLogInputSchema } from "@/lib/validations/cycle";
import { upsertCycleDayLog } from "@/lib/cycle/day-log-write";
import { findOwningCycleId } from "@/lib/cycle/cycle-attribution";
import { toCycleDayLogDTO, dayLogSymptomInclude } from "@/lib/cycle/dto";
import { DEFAULT_TIMEZONE } from "@/lib/mood/date-key";

export const POST = apiHandler(withIdempotency<[NextRequest]>(postDayLog));

async function postDayLog(request: NextRequest): Promise<Response> {
  const { user } = await requireAuth();

  const gate = await requireCycleEnabled(user.id, user.gender);
  if (!gate.enabled) return gate.response;

  const { data: rawBody, error: jsonError } = await safeJson(request);
  if (jsonError) return jsonError;

  const parsed = cycleDayLogInputSchema.safeParse(rawBody);
  if (!parsed.success) {
    annotate({
      action: { name: "cycle.day-log.validation-failed" },
      meta: { issue_count: parsed.error.issues.length },
    });
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "cycle.day-log.invalid",
    });
  }

  const entry = parsed.data;
  const tz = user.timezone ?? DEFAULT_TIMEZONE;

  const cycleId = await findOwningCycleId(user.id, entry.date);
  let result;
  try {
    result = await upsertCycleDayLog(user.id, entry, tz, cycleId);
  } catch (err: unknown) {
    // A residual unique-constraint collision (the helper adopts the
    // canonical row on the common case) surfaces as a clean 409, never a
    // 500 (the MoodEntry conflict precedent).
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: unknown }).code === "P2002"
    ) {
      annotate({
        action: { name: "cycle.day-log.conflict" },
        meta: { date: entry.date },
      });
      return apiError("Day-log already exists for this date", 409, {
        errorCode: "cycle.day-log.conflict",
      });
    }
    throw err;
  }

  const row = await prisma.cycleDayLog.findUniqueOrThrow({
    where: { id: result.id },
    include: dayLogSymptomInclude,
  });

  await auditLog("cycle.day-log.upsert", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { dayLogId: result.id, existed: result.existed },
  });

  annotate({
    action: {
      name: "cycle.day-log.upsert",
      entity_type: "cycle_day_log",
      entity_id: result.id,
    },
    meta: { existed: result.existed, source: entry.source },
  });

  return apiSuccess(toCycleDayLogDTO(row), result.existed ? 200 : 201);
}
