/**
 * `DELETE /api/cycle/all` — one-click cycle hard-delete purge.
 *
 * Distinct from the per-row soft-delete (`DELETE /api/cycle/day-logs/{id}`,
 * which leaves a tombstone for the sync feed): this HARD-deletes every
 * cycle row the user owns — day-logs (and their symptom links, by cascade),
 * menstrual cycles, predictions, and the reminder ledger — so nothing
 * reproductive persists in Postgres. The `CycleProfile` row is reset to its
 * defaults (tracking left enabled) rather than dropped, so the gate and
 * settings page keep working.
 *
 * Gated (`cycle.disabled` 403) and owner-scoped. Audited.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, getClientIp } from "@/lib/api-response";
import { requireCycleEnabled } from "@/lib/cycle/gate";

export const DELETE = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const gate = await requireCycleEnabled(user.id, user.gender);
  if (!gate.enabled) return gate.response;

  // Hard delete in a transaction. Symptom links cascade off the day-log
  // delete (the schema's onDelete: Cascade). Order child-before-parent for
  // the rows that don't cascade.
  const cleared = await prisma.$transaction(async (tx) => {
    const dayLogs = await tx.cycleDayLog.deleteMany({
      where: { userId: user.id },
    });
    const predictions = await tx.cyclePrediction.deleteMany({
      where: { userId: user.id },
    });
    const cycles = await tx.menstrualCycle.deleteMany({
      where: { userId: user.id },
    });
    return {
      dayLogs: dayLogs.count,
      predictions: predictions.count,
      cycles: cycles.count,
    };
  });

  await auditLog("cycle.purge", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: cleared,
  });

  annotate({
    action: { name: "cycle.purge" },
    meta: cleared,
  });

  return apiSuccess({ purged: true, ...cleared });
});
