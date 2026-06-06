/**
 * `DELETE /api/cycle/all` — one-click cycle hard-delete purge.
 *
 * Distinct from the per-row soft-delete (`DELETE /api/cycle/day-logs/{id}`,
 * which leaves a tombstone for the sync feed): this HARD-deletes every
 * cycle row the user owns — day-logs (and their symptom links, by cascade),
 * menstrual cycles, predictions, the cycle audit trail, and the cycle
 * reminder-delivery rows in the push-attempts ledger — so no dated
 * reproductive trace survives in Postgres (the post-Dobbs threat model). The
 * `CycleProfile` row is left in place (gate + settings keep working).
 *
 * Gated (`cycle.disabled` 403) and owner-scoped. The purge action itself IS
 * audited (written after the transaction, so it survives) — its `details`
 * carry only counts, no reproductive content.
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
    // The cycle audit trail carries dated reproductive-adjacent details
    // (period boundaries, the AVOID_PREGNANCY goal-nudge, goal changes). A
    // purge that promises "nothing reproductive persists" must clear it too.
    // The purge's own audit row is written AFTER this transaction, so it
    // survives (counts only, no reproductive content).
    const auditRows = await tx.auditLog.deleteMany({
      where: {
        userId: user.id,
        OR: [
          { action: { startsWith: "cycle." } },
          { action: "user.cycle-prefs.update" },
        ],
      },
    });
    // The shared push-attempts ledger holds dated cycle reminder-delivery
    // rows (eventType + createdAt) for up to 90 days — drop the cycle ones.
    const pushRows = await tx.pushAttempt.deleteMany({
      where: {
        userId: user.id,
        eventType: { in: ["CYCLE_PERIOD_SOON", "CYCLE_PERIOD_CONFIRM"] },
      },
    });
    return {
      dayLogs: dayLogs.count,
      predictions: predictions.count,
      cycles: cycles.count,
      auditRows: auditRows.count,
      pushRows: pushRows.count,
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
