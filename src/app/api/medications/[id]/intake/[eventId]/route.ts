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
  sanitiseZodIssues,
} from "@/lib/api-response";
import { updateIntakeEventSchema } from "@/lib/validations/medication";
import { reconcileOneShotState } from "@/lib/medications/lifecycle";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import { recomputeMedicationComplianceForEvent } from "@/lib/rollups/medication-compliance-rollups";
import { dayKeyForUserTz } from "@/lib/measurements/consolidation-tz";
import {
  applyCanonicalSlotWrite,
  resolveForcedSlotForWrite,
  resolveSlotForWriteByBand,
} from "@/lib/medications/scheduling/slot-upsert";
import { NextRequest } from "next/server";

type RouteParams = { params: Promise<{ id: string; eventId: string }> };

export const PUT = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const { id, eventId } = await params;

    // v1.7.0 sync — a tombstoned event 404s on PUT; the `deletedAt: null`
    // filter refuses to resurrect-edit a soft-deleted intake.
    const event = await prisma.medicationIntakeEvent.findFirst({
      where: { id: eventId, deletedAt: null },
    });

    if (!event || event.userId !== user.id || event.medicationId !== id) {
      return apiError("Intake not found", 404);
    }

    const { data: body, error: jsonError } = await safeJson(request);

    if (jsonError) return jsonError;
    const parsed = updateIntakeEventSchema.safeParse(body);
    if (!parsed.success) {
      // v1.4.43 W6 — per-event update hot path; multi-issue 422 +
      // audit breadcrumb keyed
      // `medications.intake.event.update.validation-failed`.
      const issues = sanitiseZodIssues(parsed.error.issues);
      annotate({
        action: { name: "medications.intake.event.update.validation-failed" },
        meta: {
          issue_count: issues.length,
          medication_id: id,
          event_id: eventId,
        },
      });
      prisma.auditLog
        .create({
          data: {
            userId: user.id,
            action: "medications.intake.event.update.validation-failed",
            details: JSON.stringify({
              issues,
              medicationId: id,
              eventId,
            }),
          },
        })
        .catch(() => {
          /* swallow — 422 response is the contract */
        });
      return returnAllZodIssues(parsed.error, 422);
    }

    const data = parsed.data;

    // v1.15.19 — start-date guard on an edited `takenAt` (audit P0-4). The
    // schema bounds the instant to a plausible absolute range; this check
    // adds the per-medication floor: a take cannot predate the day the
    // medication starts (calendar-day comparison in the user's timezone, so
    // a take in the early hours of the start day never false-rejects).
    if (data.takenAt instanceof Date) {
      const medication = await prisma.medication.findFirst({
        where: { id, userId: user.id },
        select: { startsOn: true },
      });
      if (medication?.startsOn) {
        const takenDay = dayKeyForUserTz(data.takenAt, user.timezone);
        const startsOnDay = medication.startsOn.toISOString().slice(0, 10);
        if (takenDay < startsOnDay) {
          annotate({
            action: {
              name: "medications.intake.event.update.before-start-date",
            },
            meta: { medication_id: id, event_id: eventId },
          });
          return apiError(
            "takenAt is before the medication's start date",
            422,
            { errorCode: "medications.intake.taken_at.before_start" },
          );
        }
      }
    }

    // The post-edit state of the row (current values where the body omits a
    // field) — drives the re-attribution decision.
    const nextTakenAt =
      data.takenAt !== undefined ? data.takenAt : event.takenAt;
    const nextSkipped =
      data.skipped !== undefined ? data.skipped : event.skipped;
    const takenOrSkippedChanged =
      (data.takenAt !== undefined &&
        data.takenAt?.getTime() !== event.takenAt?.getTime()) ||
      (data.skipped !== undefined && data.skipped !== event.skipped);

    // v1.15.18 — re-run window-band attribution when the edit moves `takenAt`
    // or `skipped`, so an edited time re-binds to the correct slot instead of
    // leaving `scheduledFor` stale (audit HIGH-4). Precedence:
    //   1. an explicit `scheduledFor` in the body wins (deliberate override);
    //   2. else `forceSlotInstant` pins onto a named real slot (422 if it is
    //      not a slot of this med);
    //   3. else a taken edit attributes by band (slot anchor on match, the
    //      take's own time on a miss → ad-hoc);
    //   4. a skip / pending edit keeps the existing `scheduledFor` anchor.
    let resolvedScheduledFor: Date | undefined = data.scheduledFor;
    if (resolvedScheduledFor === undefined && takenOrSkippedChanged) {
      if (data.forceSlotInstant !== undefined) {
        const forced = await resolveForcedSlotForWrite({
          userId: user.id,
          medicationId: id,
          userTz: user.timezone,
          slotInstant: data.forceSlotInstant,
        });
        if (forced === null) {
          annotate({
            action: { name: "medication.intake.force_slot.invalid" },
            meta: { medication_id: id, event_id: eventId },
          });
          return apiError(
            "forceSlotInstant is not a scheduled slot of this medication",
            422,
            { errorCode: "medications.intake.force_slot.invalid" },
          );
        }
        resolvedScheduledFor = forced;
      } else if (nextTakenAt !== null && !nextSkipped) {
        const attribution = await resolveSlotForWriteByBand({
          userId: user.id,
          medicationId: id,
          userTz: user.timezone,
          takenAt: nextTakenAt,
        });
        // band.at on match; the take's own time on a miss (ad-hoc).
        resolvedScheduledFor = attribution.slotInstant ?? nextTakenAt;
      }
      // skip / pending edits leave `scheduledFor` on the existing anchor.
    }

    const targetScheduledFor = resolvedScheduledFor ?? event.scheduledFor;
    const slotMoved =
      targetScheduledFor.getTime() !== event.scheduledFor.getTime();

    let updated;
    if (!slotMoved) {
      // The slot is unchanged — a bare in-place update can never collide with
      // a sibling row (it is its own slot).
      updated = await prisma.medicationIntakeEvent.update({
        where: { id: eventId },
        data: {
          ...(data.takenAt !== undefined && { takenAt: data.takenAt }),
          ...(data.skipped !== undefined && { skipped: data.skipped }),
          // v1.7.0 sync — bump the reconciliation counter on every
          // server-side mutation so the `/api/sync/changes` feed echoes a
          // monotonic value to paired clients.
          syncVersion: { increment: 1 },
        },
      });
    } else {
      // The edit moved the dose to a different slot. Tombstone the original
      // row (the iOS "a correction is a tombstone + re-insert" model the
      // DELETE handler documents) and route the corrected dose through the
      // shared canonical-slot upsert, which converges onto any row already at
      // the target slot (a pending REMINDER row) rather than bare-updating
      // into an occupied slot and risking a P2002 (audit HIGH-4).
      await prisma.medicationIntakeEvent.update({
        where: { id: eventId },
        data: { deletedAt: new Date(), syncVersion: { increment: 1 } },
      });
      const applied = await applyCanonicalSlotWrite({
        client: prisma,
        userId: user.id,
        medicationId: id,
        canonicalSlot: targetScheduledFor,
        takenAt: nextSkipped ? null : nextTakenAt,
        skipped: nextSkipped,
        isExplicitTaken: !nextSkipped && nextTakenAt !== null,
        isExplicitSkip: nextSkipped,
        idempotencyKey: null,
        createSource: "WEB",
      });
      updated = applied.row;
    }

    await auditLog("medication.intake.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { eventId, medicationId: id },
    });

    annotate({
      action: {
        name: "medication.intake.update",
        entity_type: "intake_event",
        entity_id: eventId,
      },
      meta: { medication_id: id },
    });

    // v1.4.34 IW-G — bust per-user medications + compliance + achievement
    // caches so the next read reflects the edited event.
    invalidateUserMedications(user.id);

    // v1.4.39 W-MED — refresh the rollup row for both the old + new
    // scheduledFor day-keys when the dose moved across a day boundary
    // (band re-attribution can move it as well as an explicit edit); if the
    // slot is unchanged the second call collapses to a no-op upsert.
    await recomputeMedicationComplianceForEvent({
      userId: user.id,
      medicationId: id,
      scheduledFor: event.scheduledFor,
      tz: user.timezone,
    });
    if (slotMoved) {
      await recomputeMedicationComplianceForEvent({
        userId: user.id,
        medicationId: id,
        scheduledFor: targetScheduledFor,
        tz: user.timezone,
      });
    }

    // v1.5.0 — re-evaluate the one-shot active flag. A skip-flip on the
    // single live intake of a one-shot medication should reactivate it
    // (the dose is no longer logged), and the reverse case should
    // deactivate again. No-op for non-one-shot medications.
    await reconcileOneShotState(prisma, id, user.id);

    return apiSuccess(updated);
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const { id, eventId } = await params;

    const event = await prisma.medicationIntakeEvent.findUnique({
      where: { id: eventId },
    });

    if (!event || event.userId !== user.id || event.medicationId !== id) {
      return apiError("Intake not found", 404);
    }

    // v1.7.0 sync — soft-delete instead of a hard `delete`. An intake is
    // an immutable fact, so a "correction" is a tombstone + re-insert
    // (never an in-place edit). Setting `deletedAt` (+ bumping
    // `syncVersion`) leaves the row in place so the `/api/sync/changes`
    // feed surfaces the deletion as a tombstone keyed on the server `id`
    // to paired clients offline at delete time. Every today / compliance
    // / list read filters `deletedAt: null`, so the row is invisible to
    // normal reads from here on. A re-delete re-bumps harmlessly.
    await prisma.medicationIntakeEvent.update({
      where: { id: eventId },
      data: {
        deletedAt: new Date(),
        syncVersion: { increment: 1 },
      },
    });

    const ip = getClientIp(request) ?? "unknown";
    await auditLog("medication.intake.delete", {
      userId: user.id,
      ipAddress: ip,
      details: { eventId, medicationId: id },
    });

    annotate({
      action: {
        name: "medication.intake.delete",
        entity_type: "intake_event",
        entity_id: eventId,
      },
      meta: { medication_id: id },
    });

    // v1.4.34 IW-G — bust per-user medications + compliance + achievement
    // caches so the next read reflects the deletion.
    invalidateUserMedications(user.id);

    // v1.4.39 W-MED — refresh the rollup row for the day the deleted
    // event sat on. When that day now holds zero events the helper
    // drops the rollup row entirely.
    await recomputeMedicationComplianceForEvent({
      userId: user.id,
      medicationId: id,
      scheduledFor: event.scheduledFor,
      tz: user.timezone,
    });

    // v1.5.0 — re-evaluate the one-shot active flag. Deleting the
    // single live intake of a one-shot medication reactivates it so
    // the dashboard / lists / worker pick it back up. No-op for
    // non-one-shot medications.
    await reconcileOneShotState(prisma, id, user.id);

    return apiSuccess({ deleted: true });
  },
);
