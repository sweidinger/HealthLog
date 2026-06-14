/**
 * v1.17.1 — Vorsorge (measurement) reminder by id: get + patch + delete.
 *
 * PATCH re-derives the server-authoritative `nextDueAt` after applying
 * the (mutually-exclusive cadence) edit. DELETE soft-deletes (tombstone)
 * for parity with the rest of the tree.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiSuccess,
  apiError,
  getClientIp,
  returnAllZodIssues,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { updateMeasurementReminderSchema } from "@/lib/validations/measurement-reminders";
import {
  computeReminderNextDueAt,
  type ReminderScheduleInput,
} from "@/lib/measurement-reminders/scheduling";
import { toMeasurementReminderDto } from "@/lib/measurement-reminders/dto";

type RouteParams = { params: Promise<{ id: string }> };

const DEFAULT_TIMEZONE = "Europe/Berlin";

async function resolveTimezone(userId: string): Promise<string> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  return row?.timezone || DEFAULT_TIMEZONE;
}

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { id } = await params;

    const reminder = await prisma.measurementReminder.findFirst({
      where: { id, deletedAt: null },
    });
    if (!reminder || reminder.userId !== user.id) {
      return apiError("Measurement reminder not found", 404);
    }

    annotate({
      action: { name: "measurement-reminders.get" },
      meta: { reminderId: id },
    });

    return apiSuccess(toMeasurementReminderDto(reminder));
  },
);

export const PATCH = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { id } = await params;

    const existing = await prisma.measurementReminder.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing || existing.userId !== user.id) {
      return apiError("Measurement reminder not found", 404);
    }

    const { data: body, error: jsonError } = await safeJson(request, {
      maxBytes: 16 * 1024,
    });
    if (jsonError) return jsonError;

    const parsed = updateMeasurementReminderSchema.safeParse(body);
    if (!parsed.success) {
      const issues = sanitiseZodIssues(parsed.error.issues);
      annotate({
        action: { name: "measurement-reminders.update.validation-failed" },
        meta: { issue_count: issues.length, reminderId: id },
      });
      const auditIssues = sanitiseZodIssues(parsed.error.issues, {
        stripValuesFromMessage: true,
      });
      prisma.auditLog
        .create({
          data: {
            userId: user.id,
            action: "measurement-reminders.update.validation-failed",
            details: JSON.stringify({ issues: auditIssues, reminderId: id }),
          },
        })
        .catch(() => {
          /* swallow — 422 response is the contract */
        });
      return returnAllZodIssues(parsed.error, 422);
    }

    const data = parsed.data;

    // Field-by-field — no mass assignment.
    const updateData: Record<string, unknown> = {};
    if (data.label !== undefined) updateData.label = data.label;
    if (data.measurementType !== undefined) {
      updateData.measurementType = data.measurementType;
    }
    if (data.intervalDays !== undefined) {
      updateData.intervalDays = data.intervalDays;
      // Setting one cadence clears the other so the engine reads exactly
      // one dispatch family.
      if (data.intervalDays !== null && data.rrule === undefined) {
        updateData.rrule = null;
      }
    }
    if (data.rrule !== undefined) {
      updateData.rrule = data.rrule;
      if (data.rrule !== null && data.intervalDays === undefined) {
        updateData.intervalDays = null;
      }
    }
    if (data.anchorDate !== undefined) {
      updateData.anchorDate =
        data.anchorDate != null ? new Date(data.anchorDate) : null;
    }
    if (data.notifyHour !== undefined) updateData.notifyHour = data.notifyHour;
    if (data.location !== undefined) updateData.location = data.location;
    if (data.enabled !== undefined) updateData.enabled = data.enabled;

    // Recompute next-due against the merged cadence. Floor the search at
    // the last-satisfied instant (or now) so a cadence edit re-anchors
    // cleanly off the user's last fulfilment.
    const timezone = await resolveTimezone(user.id);
    const now = new Date();
    const merged: ReminderScheduleInput = {
      intervalDays:
        (updateData.intervalDays as number | null | undefined) ??
        existing.intervalDays,
      rrule: (updateData.rrule as string | null | undefined) ?? existing.rrule,
      anchorDate:
        (updateData.anchorDate as Date | null | undefined) ??
        existing.anchorDate,
      notifyHour:
        (updateData.notifyHour as number | undefined) ?? existing.notifyHour,
      lastSatisfiedAt: existing.lastSatisfiedAt,
      createdAt: existing.createdAt,
    };
    const after =
      existing.lastSatisfiedAt && existing.lastSatisfiedAt > now
        ? existing.lastSatisfiedAt
        : now;
    updateData.nextDueAt = computeReminderNextDueAt(merged, timezone, after);

    const updated = await prisma.measurementReminder.update({
      where: { id },
      data: updateData,
    });

    await auditLog("measurementReminder.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { reminderId: id },
    });

    annotate({
      action: { name: "measurement-reminders.update" },
      meta: { reminderId: id },
    });

    return apiSuccess(toMeasurementReminderDto(updated));
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { id } = await params;

    const existing = await prisma.measurementReminder.findUnique({
      where: { id },
    });
    if (!existing || existing.userId !== user.id) {
      return apiError("Measurement reminder not found", 404);
    }

    // Soft-delete (tombstone) parity with the rest of the tree. A
    // re-delete of an already-tombstoned row is idempotent.
    await prisma.measurementReminder.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    await auditLog("measurementReminder.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { reminderId: id },
    });

    annotate({
      action: { name: "measurement-reminders.delete" },
      meta: { reminderId: id },
    });

    return apiSuccess({ deleted: true });
  },
);
