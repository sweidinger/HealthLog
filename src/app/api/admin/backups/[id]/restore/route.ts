/**
 * POST /api/admin/backups/[id]/restore — admin-only disaster recovery.
 *
 * After owner and schema validation, one transaction replaces every
 * serialized owner-scoped class: measurements, medication history, mood and
 * rated factors, cycle data, labs/biomarkers, illness history, allergies,
 * family history, workout summaries, and inbound documents. Document content
 * and summary ciphertext are decoded from base64 and persisted verbatim.
 *
 * Metadata-only portable document exports are rejected before mutation; the
 * importer never fabricates content. Audit rows remain outside the wipe, and
 * cache invalidation runs only after the complete restore transaction.
 */
import { Buffer } from "node:buffer";

import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { apiHandler, HttpError, requireAdmin } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { decrypt } from "@/lib/crypto";
import { encryptNote } from "@/lib/crypto/note-cipher";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { encryptContextToBytes } from "@/lib/labs/biomarker-store";
import { encryptNoteToBytes } from "@/lib/labs/store";
import { defaultUserIdResolver, withIdempotency } from "@/lib/idempotency";
import { annotate } from "@/lib/logging/context";
import {
  parseBackupPayload,
  summarizeBackup,
  type BackupSummary,
} from "@/lib/validations/backup";
import { recomputeUserMoodRollups } from "@/lib/rollups/mood-rollups";
import {
  recomputeUserMedicationCompliance,
  MEDICATION_COMPLIANCE_BACKFILL_DAYS,
} from "@/lib/rollups/medication-compliance-rollups";
import { recomputeUserRollups } from "@/lib/rollups/measurement-rollups";
import { restoreCycleData } from "@/lib/cycle/backup";
import { invalidateUserData } from "@/lib/cache/invalidate";

export const dynamic = "force-dynamic";

interface RestoreResponse {
  restored: true;
  summary: BackupSummary;
  cleared: {
    measurements: number;
    medications: number;
    intakeEvents: number;
    moodEntries: number;
    notificationChannels: number;
    pushSubscriptions: number;
    telegramScheduledDeletions: number;
    cycles: number;
    cycleDayLogs: number;
    cycleProfile: number;
    labResults: number;
    biomarkers: number;
    illnessEpisodes: number;
    allergies: number;
    familyHistory: number;
    workouts: number;
    documents: number;
  };
}

function decodeEncryptedBytes(encoded: string): Uint8Array<ArrayBuffer> {
  const decoded = Buffer.from(encoded, "base64");
  const bytes = new Uint8Array(new ArrayBuffer(decoded.byteLength));
  bytes.set(decoded);
  return bytes;
}

/**
 * Maps a measurement-type string from the backup back into the
 * Prisma enum literal. Backups are written from `enum MeasurementType`
 * (Postgres-mapped to lowercase column type), so the round-trip is
 * normally identity. But the schema is a `passthrough` schema so a
 * malformed type slips through Zod — guard it explicitly here so the
 * restore fails fast instead of erroring deep in `prisma.create()`.
 */
const MEASUREMENT_TYPES = new Set([
  "WEIGHT",
  "BLOOD_PRESSURE_SYS",
  "BLOOD_PRESSURE_DIA",
  "PULSE",
  "BODY_FAT",
  "SLEEP_DURATION",
  "ACTIVITY_STEPS",
  "BLOOD_GLUCOSE",
  "TOTAL_BODY_WATER",
  "BONE_MASS",
  "OXYGEN_SATURATION",
  // ── v1.4.23 Apple Health additions ──
  "HEART_RATE_VARIABILITY",
  "RESTING_HEART_RATE",
  "ACTIVE_ENERGY_BURNED",
  "FLIGHTS_CLIMBED",
  "WALKING_RUNNING_DISTANCE",
  "VO2_MAX",
  "BODY_TEMPERATURE",
]);

const MEASUREMENT_SOURCES = new Set([
  "MANUAL",
  "WITHINGS",
  "IMPORT",
  "APPLE_HEALTH",
]);
const INTAKE_SOURCES = new Set(["WEB", "API", "REMINDER", "IMPORT"]);

const handler = apiHandler(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) => {
    const { user: admin } = await requireAdmin();
    const { id } = await params;
    annotate({ action: { name: "admin.backups.restore" }, meta: { id } });

    let body: { confirm?: string } = {};
    try {
      const raw = await request.text();
      if (raw.length > 64 * 1024) {
        return apiError(`Request body exceeds ${64 * 1024} bytes`, 413);
      }
      body = JSON.parse(raw) as { confirm?: string };
    } catch {
      return apiError("Invalid JSON body", 400);
    }

    if (body.confirm !== "RESTORE") {
      await auditLog("admin.backups.restore.denied", {
        userId: admin.id,
        ipAddress: getClientIp(request),
        details: { reason: "missing_confirmation", backupId: id },
      });
      return apiError(
        "Confirmation token missing — body must include confirm: 'RESTORE'",
        422,
      );
    }

    const backup = await prisma.dataBackup.findUnique({
      where: { id },
      include: { user: { select: { id: true, username: true } } },
    });
    if (!backup) {
      await auditLog("admin.backups.restore.denied", {
        userId: admin.id,
        ipAddress: getClientIp(request),
        details: { reason: "not_found", backupId: id },
      });
      throw new HttpError(404, "Backup not found");
    }

    let plaintext: string;
    try {
      plaintext = decrypt(backup.data);
    } catch (err) {
      await auditLog("admin.backups.restore.failed", {
        userId: admin.id,
        ipAddress: getClientIp(request),
        details: {
          backupId: id,
          ownerId: backup.userId,
          reason: err instanceof Error ? err.message : "decrypt_failed",
        },
      });
      return apiError("Failed to decrypt backup payload", 500);
    }

    let payload;
    try {
      payload = parseBackupPayload(plaintext);
    } catch (err) {
      await auditLog("admin.backups.restore.failed", {
        userId: admin.id,
        ipAddress: getClientIp(request),
        details: {
          backupId: id,
          ownerId: backup.userId,
          reason: "schema_invalid",
          message: err instanceof Error ? err.message : String(err),
        },
      });
      return apiError("Backup payload failed schema validation", 500);
    }

    // The payload declares its own owner, and the backup ROW records who the
    // backup was taken for. Those must agree. Taking the owner from the
    // payload alone means the restored-into account is whatever the blob
    // claims — so an admin who selects one user's backup could write into a
    // different account without the interface ever showing it. Both values are
    // already in hand here; refuse on mismatch rather than trusting the blob.
    if (payload.userId !== backup.userId) {
      await auditLog("admin.backups.restore.failed", {
        userId: admin.id,
        ipAddress: getClientIp(request),
        details: {
          backupId: id,
          ownerId: backup.userId,
          reason: "owner_mismatch",
          declaredOwnerId: payload.userId,
        },
      });
      return apiError(
        "Backup payload declares a different owner than the backup record",
        409,
      );
    }

    // The target of the restore is whoever the backup is for, NOT the
    // admin running the operation. Make sure that user still exists —
    // an upload referencing a since-deleted user would otherwise leave
    // the operation half-done.
    const ownerId = payload.userId;
    const owner = await prisma.user.findUnique({
      where: { id: ownerId },
      select: { id: true, username: true },
    });
    if (!owner) {
      await auditLog("admin.backups.restore.failed", {
        userId: admin.id,
        ipAddress: getClientIp(request),
        details: {
          backupId: id,
          ownerId,
          reason: "owner_not_found",
        },
      });
      return apiError(
        `Backup owner '${ownerId}' no longer exists in this DB`,
        422,
      );
    }

    // Audit the *intent* before the transaction begins so the trail
    // describing "an admin is about to restore <user>" survives even
    // if the operation crashes midway.
    await auditLog("admin.backups.restore.start", {
      userId: admin.id,
      ipAddress: getClientIp(request),
      details: {
        backupId: id,
        ownerId,
        ownerUsername: owner.username,
        snapshotExportedAt: payload.exportedAt,
      },
    });

    // Pre-validate enum values OUTSIDE the transaction so a malformed
    // payload doesn't half-wipe the user before failing the create
    // step. Cheap up-front guard.
    for (const m of payload.measurements) {
      if (!MEASUREMENT_TYPES.has(m.type)) {
        await auditLog("admin.backups.restore.failed", {
          userId: admin.id,
          ipAddress: getClientIp(request),
          details: {
            backupId: id,
            ownerId,
            reason: "unknown_measurement_type",
            type: m.type,
          },
        });
        return apiError(`Unknown measurement type in backup: '${m.type}'`, 422);
      }
      if (m.source && !MEASUREMENT_SOURCES.has(m.source)) {
        await auditLog("admin.backups.restore.failed", {
          userId: admin.id,
          ipAddress: getClientIp(request),
          details: {
            backupId: id,
            ownerId,
            reason: "unknown_measurement_source",
            source: m.source,
          },
        });
        return apiError(
          `Unknown measurement source in backup: '${m.source}'`,
          422,
        );
      }
    }
    for (const e of payload.intakeEvents) {
      if (e.source && !INTAKE_SOURCES.has(e.source)) {
        await auditLog("admin.backups.restore.failed", {
          userId: admin.id,
          ipAddress: getClientIp(request),
          details: {
            backupId: id,
            ownerId,
            reason: "unknown_intake_source",
            source: e.source,
          },
        });
        return apiError(`Unknown intake source in backup: '${e.source}'`, 422);
      }
    }

    // Portable exports intentionally omit document ciphertext. They remain
    // valid upload/download artifacts, but cannot be used to manufacture an
    // InboundDocument row. A DR restore must fail before any delete rather
    // than inventing empty/plaintext content.
    const incompleteDocument = payload.documents.find(
      (document) =>
        document.contentEncrypted === undefined ||
        document.contentSha256 === undefined ||
        document.contentCodec === undefined ||
        document.providerType === undefined ||
        document.reportDate === undefined ||
        document.documentDate === undefined ||
        document.errorReason === undefined ||
        document.summaryEncrypted === undefined ||
        document.summaryGeneratedAt === undefined ||
        document.summaryState === undefined ||
        document.createdAt === undefined ||
        document.updatedAt === undefined,
    );
    if (incompleteDocument) {
      await auditLog("admin.backups.restore.failed", {
        userId: admin.id,
        ipAddress: getClientIp(request),
        details: {
          backupId: id,
          ownerId,
          reason: "document_ciphertext_missing",
          documentId: incompleteDocument.id,
        },
      });
      return apiError(
        `Document '${incompleteDocument.id}' is metadata-only and cannot be restored`,
        422,
      );
    }

    let cleared: RestoreResponse["cleared"];
    try {
      cleared = await prisma.$transaction(async (tx) => {
        // Delete every serialized owner-scoped partition before rebuilding it
        // in the same transaction. Child rows either go first for counts or
        // cascade from their serialized parent.
        const intake = await tx.medicationIntakeEvent.deleteMany({
          where: { userId: ownerId },
        });
        const meds = await tx.medication.deleteMany({
          where: { userId: ownerId },
        });
        const measurements = await tx.measurement.deleteMany({
          where: { userId: ownerId },
        });
        const moods = await tx.moodEntry.deleteMany({
          where: { userId: ownerId },
        });
        // v1.4.39 W-MOOD — wipe the persisted mood rollup partition
        // for this owner so the next analytics read doesn't surface
        // pre-restore daily means. The fold below mints fresh rows
        // from the restored mood entries.
        await tx.moodEntryRollup.deleteMany({ where: { userId: ownerId } });
        // v1.4.39.1 — wipe the persisted measurement rollup partition
        // for the same reason. Pre-fix the partition kept the previous
        // owner's daily means even after the underlying measurements
        // were replaced — the chart's `source=rollup` fast-path could
        // surface a stale 30-day mean built from rows that no longer
        // existed. The fold below mints fresh rows from the restored
        // measurement set.
        await tx.measurementRollup.deleteMany({ where: { userId: ownerId } });
        const channels = await tx.notificationChannel.deleteMany({
          where: { userId: ownerId },
        });
        const subs = await tx.pushSubscription.deleteMany({
          where: { userId: ownerId },
        });
        const tgDel = await tx.telegramScheduledDeletion.deleteMany({
          where: { userId: ownerId },
        });
        const documents = await tx.inboundDocument.deleteMany({
          where: { userId: ownerId },
        });
        const workouts = await tx.workout.deleteMany({
          where: { userId: ownerId },
        });
        const familyHistory = await tx.familyHistoryEntry.deleteMany({
          where: { userId: ownerId },
        });
        const allergies = await tx.allergy.deleteMany({
          where: { userId: ownerId },
        });
        const illnessEpisodes = await tx.illnessEpisode.deleteMany({
          where: { userId: ownerId },
        });
        const labResults = await tx.labResult.deleteMany({
          where: { userId: ownerId },
        });
        const biomarkers = await tx.biomarker.deleteMany({
          where: { userId: ownerId },
        });

        // ── re-create from payload ──
        if (payload.measurements.length > 0) {
          await tx.measurement.createMany({
            data: payload.measurements.map((m) => ({
              userId: ownerId,
              type: m.type as never, // already enum-validated above
              value: m.value,
              unit: m.unit,
              source: (m.source ?? "MANUAL") as never,
              measuredAt: new Date(m.measuredAt),
              // v1.23 — re-encrypt the note from the (decrypted) backup payload
              // into the at-rest column; legacy plaintext column nulled.
              notes: null,
              notesEncrypted: encryptNote(m.notes ?? null),
            })),
            // Backups can replay the same data — the unique
            // (userId, type, measuredAt, source) constraint catches
            // accidental dupes. `skipDuplicates` keeps the restore
            // idempotent across retries instead of throwing.
            skipDuplicates: true,
          });
        }

        // Medications + schedules — restore one at a time so we can
        // wire schedules to their parent's freshly-generated id, AND
        // build a name → id map for the intake events that follow.
        const medByName = new Map<string, string>();
        for (const m of payload.medications) {
          const created = await tx.medication.create({
            data: {
              userId: ownerId,
              name: m.name,
              dose: m.dose,
              active: m.active ?? true,
              schedules: {
                create: m.schedules.map((s) => ({
                  windowStart: s.windowStart,
                  windowEnd: s.windowEnd,
                  label: s.label ?? null,
                  dose: s.dose ?? null,
                })),
              },
            },
          });
          // First write wins on duplicate names — keeps the round-trip
          // deterministic against the restore-from-our-own-download case.
          if (!medByName.has(m.name)) medByName.set(m.name, created.id);
        }

        // Intake events — only restore the ones whose `medication` name
        // resolved against a row we just created. Orphans (medications
        // that were deleted before the snapshot but still referenced by
        // intake events) are dropped silently — the alternative would
        // be an FK-violation crash, which is worse than a slightly
        // smaller history.
        if (payload.intakeEvents.length > 0) {
          const rows = payload.intakeEvents
            .map((e) => {
              const medId = medByName.get(e.medication);
              if (!medId) return null;
              return {
                userId: ownerId,
                medicationId: medId,
                scheduledFor: new Date(e.scheduledFor),
                takenAt: e.takenAt ? new Date(e.takenAt) : null,
                skipped: e.skipped ?? false,
                source: (e.source ?? "WEB") as never,
              };
            })
            .filter((r): r is NonNullable<typeof r> => r !== null);
          if (rows.length > 0) {
            await tx.medicationIntakeEvent.createMany({ data: rows });
          }
        }

        if (payload.moodEntries.length > 0) {
          const factorKeys = [
            ...new Set(
              payload.moodEntries.flatMap((entry) =>
                entry.factors.map((factor) => factor.key),
              ),
            ),
          ];
          const factorRows =
            factorKeys.length === 0
              ? []
              : await tx.moodTag.findMany({
                  where: {
                    key: { in: factorKeys },
                    kind: "RATED",
                    userId: null,
                  },
                  select: { id: true, key: true },
                });
          const factorByKey = new Map(
            factorRows.map((factor) => [factor.key, factor.id]),
          );
          if (factorByKey.size !== factorKeys.length) {
            const missing = factorKeys.filter((key) => !factorByKey.has(key));
            throw new Error(`Unknown mood factor keys: ${missing.join(", ")}`);
          }

          for (const entry of payload.moodEntries) {
            const created = await tx.moodEntry.create({
              data: {
                ...(entry.id ? { id: entry.id } : {}),
                userId: ownerId,
                date: entry.date,
                mood: entry.mood,
                score: entry.score,
                tags: entry.tags ?? null,
                source: entry.source ?? "MOODLOG",
                externalId: entry.externalId ?? null,
                moodLoggedAt: new Date(entry.loggedAt),
              },
            });
            if (entry.factors.length > 0) {
              await tx.moodEntryTagLink.createMany({
                data: entry.factors.map((factor) => ({
                  moodEntryId: created.id,
                  moodTagId: factorByKey.get(factor.key)!,
                  rating: factor.rating,
                })),
              });
            }
          }
        }

        // v1.15.0 — cycle tables (profile + observed spans + day-logs +
        // symptom links). Delete-then-recreate, mirroring the contract
        // above. `notesEncrypted` is restored as ciphertext verbatim.
        const cycleCleared = await restoreCycleData(tx, ownerId, payload);

        const biomarkerByName = new Map<string, string>();
        for (const biomarker of payload.biomarkers) {
          const created = await tx.biomarker.create({
            data: {
              ...(biomarker.id ? { id: biomarker.id } : {}),
              userId: ownerId,
              name: biomarker.name,
              unit: biomarker.unit,
              lowerBound: biomarker.lowerBound ?? null,
              upperBound: biomarker.upperBound ?? null,
              panel: biomarker.panel ?? null,
              hidden: biomarker.hidden ?? false,
              contextEncrypted:
                biomarker.context == null
                  ? null
                  : encryptContextToBytes(biomarker.context),
              ...(biomarker.createdAt
                ? { createdAt: new Date(biomarker.createdAt) }
                : {}),
              ...(biomarker.updatedAt
                ? { updatedAt: new Date(biomarker.updatedAt) }
                : {}),
            },
          });
          biomarkerByName.set(biomarker.name, created.id);
        }

        for (const lab of payload.labResults) {
          const biomarkerId = lab.biomarkerName
            ? biomarkerByName.get(lab.biomarkerName)
            : undefined;
          if (lab.biomarkerName && !biomarkerId) {
            throw new Error(
              `Unknown biomarker reference: ${lab.biomarkerName}`,
            );
          }
          await tx.labResult.create({
            data: {
              ...(lab.id ? { id: lab.id } : {}),
              userId: ownerId,
              biomarkerId: biomarkerId ?? null,
              panel: lab.panel ?? null,
              analyte: lab.analyte,
              value: lab.value ?? null,
              valueText: lab.valueText ?? null,
              unit: lab.unit,
              referenceLow: lab.referenceLow ?? null,
              referenceHigh: lab.referenceHigh ?? null,
              takenAt: new Date(lab.takenAt),
              source: lab.source,
              noteEncrypted:
                lab.note == null ? null : encryptNoteToBytes(lab.note),
              ...(lab.createdAt
                ? { createdAt: new Date(lab.createdAt) }
                : {}),
              ...(lab.updatedAt
                ? { updatedAt: new Date(lab.updatedAt) }
                : {}),
            },
          });
        }

        const episodeIds = new Set(
          payload.illnessEpisodes.map((episode) => episode.id),
        );
        for (const episode of payload.illnessEpisodes) {
          if (
            episode.parentConditionId &&
            !episodeIds.has(episode.parentConditionId)
          ) {
            throw new Error(
              `Unknown illness parent: ${episode.parentConditionId}`,
            );
          }
          await tx.illnessEpisode.create({
            data: {
              id: episode.id,
              userId: ownerId,
              label: episode.label,
              type: episode.type as never,
              lifecycle: episode.lifecycle as never,
              onsetAt: new Date(episode.onsetAt),
              resolvedAt: episode.resolvedAt
                ? new Date(episode.resolvedAt)
                : null,
              parentConditionId: null,
              noteEncrypted:
                episode.note == null ? null : encryptToBytes(episode.note),
              ...(episode.createdAt
                ? { createdAt: new Date(episode.createdAt) }
                : {}),
              ...(episode.updatedAt
                ? { updatedAt: new Date(episode.updatedAt) }
                : {}),
            },
          });
        }
        for (const episode of payload.illnessEpisodes) {
          if (episode.parentConditionId) {
            await tx.illnessEpisode.update({
              where: { id: episode.id },
              data: { parentConditionId: episode.parentConditionId },
            });
          }
        }

        const symptomKeys = [
          ...new Set(
            payload.illnessEpisodes.flatMap((episode) =>
              episode.dayLogs.flatMap((dayLog) =>
                dayLog.symptoms.map((symptom) => symptom.key),
              ),
            ),
          ),
        ];
        const symptomRows =
          symptomKeys.length === 0
            ? []
            : await tx.illnessSymptom.findMany({
                where: { key: { in: symptomKeys } },
                select: { id: true, key: true },
              });
        const symptomByKey = new Map(
          symptomRows.map((symptom) => [symptom.key, symptom.id]),
        );
        if (symptomByKey.size !== symptomKeys.length) {
          const missing = symptomKeys.filter((key) => !symptomByKey.has(key));
          throw new Error(`Unknown illness symptom keys: ${missing.join(", ")}`);
        }
        for (const episode of payload.illnessEpisodes) {
          for (const dayLog of episode.dayLogs) {
            await tx.illnessDayLog.create({
              data: {
                ...(dayLog.id ? { id: dayLog.id } : {}),
                userId: ownerId,
                episodeId: episode.id,
                date: dayLog.date,
                functionalImpact: dayLog.functionalImpact ?? null,
                feverC: dayLog.feverC ?? null,
                noteEncrypted:
                  dayLog.note == null ? null : encryptToBytes(dayLog.note),
                ...(dayLog.updatedAt
                  ? { updatedAt: new Date(dayLog.updatedAt) }
                  : {}),
                symptomLinks: {
                  create: dayLog.symptoms.map((symptom) => ({
                    symptomId: symptomByKey.get(symptom.key)!,
                    severity: symptom.severity ?? null,
                  })),
                },
              },
            });
          }
        }

        for (const allergy of payload.allergies) {
          await tx.allergy.create({
            data: {
              id: allergy.id,
              userId: ownerId,
              substance: allergy.substance,
              category: allergy.category as never,
              type: allergy.type as never,
              severity: (allergy.severity ?? null) as never,
              status: allergy.status as never,
              onsetAt: allergy.onsetAt ? new Date(allergy.onsetAt) : null,
              reactionEncrypted:
                allergy.reaction == null
                  ? null
                  : encryptToBytes(allergy.reaction),
              notesEncrypted:
                allergy.note == null ? null : encryptToBytes(allergy.note),
              ...(allergy.createdAt
                ? { createdAt: new Date(allergy.createdAt) }
                : {}),
              ...(allergy.updatedAt
                ? { updatedAt: new Date(allergy.updatedAt) }
                : {}),
            },
          });
        }

        for (const familyEntry of payload.familyHistory) {
          await tx.familyHistoryEntry.create({
            data: {
              id: familyEntry.id,
              userId: ownerId,
              relationship: familyEntry.relationship as never,
              condition: familyEntry.condition,
              ageAtOnset: familyEntry.ageAtOnset ?? null,
              notesEncrypted:
                familyEntry.note == null
                  ? null
                  : encryptToBytes(familyEntry.note),
              ...(familyEntry.createdAt
                ? { createdAt: new Date(familyEntry.createdAt) }
                : {}),
              ...(familyEntry.updatedAt
                ? { updatedAt: new Date(familyEntry.updatedAt) }
                : {}),
            },
          });
        }

        if (payload.workouts.length > 0) {
          await tx.workout.createMany({
            data: payload.workouts.map((workout) => ({
              ...(workout.id ? { id: workout.id } : {}),
              userId: ownerId,
              sportType: workout.sportType,
              startedAt: new Date(workout.startedAt),
              endedAt: new Date(workout.endedAt),
              durationSec: workout.durationSec,
              totalEnergyKcal: workout.totalEnergyKcal ?? null,
              totalDistanceM: workout.totalDistanceM ?? null,
              avgHeartRate: workout.avgHeartRate ?? null,
              maxHeartRate: workout.maxHeartRate ?? null,
              minHeartRate: workout.minHeartRate ?? null,
              stepCount: workout.stepCount ?? null,
              elevationM: workout.elevationM ?? null,
              pauseDurationSec: workout.pauseDurationSec ?? null,
              source: workout.source as never,
              externalId: workout.externalId ?? null,
              ...(workout.createdAt
                ? { createdAt: new Date(workout.createdAt) }
                : {}),
              ...(workout.updatedAt
                ? { updatedAt: new Date(workout.updatedAt) }
                : {}),
            })),
          });
        }

        if (payload.documents.length > 0) {
          await tx.inboundDocument.createMany({
            data: payload.documents.map((document) => ({
              id: document.id,
              userId: ownerId,
              kind: document.kind as never,
              title: document.title ?? null,
              filename: document.filename ?? null,
              mimeType: document.mimeType,
              byteSize: document.byteSize,
              contentEncrypted: decodeEncryptedBytes(
                document.contentEncrypted!,
              ),
              contentSha256: document.contentSha256 ?? null,
              contentCodec: document.contentCodec!,
              status: document.status as never,
              providerType: document.providerType ?? null,
              reportDate: document.reportDate
                ? new Date(document.reportDate)
                : null,
              documentDate: document.documentDate
                ? new Date(document.documentDate)
                : null,
              errorReason: document.errorReason ?? null,
              summaryEncrypted: document.summaryEncrypted
                ? decodeEncryptedBytes(document.summaryEncrypted)
                : null,
              summaryGeneratedAt: document.summaryGeneratedAt
                ? new Date(document.summaryGeneratedAt)
                : null,
              summaryState: document.summaryState as never,
              createdAt: new Date(document.createdAt!),
              updatedAt: new Date(document.updatedAt!),
            })),
          });
        }

        return {
          measurements: measurements.count,
          medications: meds.count,
          intakeEvents: intake.count,
          moodEntries: moods.count,
          notificationChannels: channels.count,
          pushSubscriptions: subs.count,
          telegramScheduledDeletions: tgDel.count,
          cycles: cycleCleared.cycles,
          cycleDayLogs: cycleCleared.cycleDayLogs,
          cycleProfile: cycleCleared.cycleProfile,
          labResults: labResults.count,
          biomarkers: biomarkers.count,
          illnessEpisodes: illnessEpisodes.count,
          allergies: allergies.count,
          familyHistory: familyHistory.count,
          workouts: workouts.count,
          documents: documents.count,
        };
      }, {
        maxWait: 10_000,
        timeout: 120_000,
      });
    } catch (err) {
      // Scrub the raw Prisma / driver error from the wire response —
      // even on an admin endpoint, leaking column names, constraint
      // names or query fragments lowers the cost of a future supply-
      // chain attack against this surface. The verbose text still
      // lands in the audit row (admin-readable) and the Wide Event
      // (operator-readable), so root-cause investigation is unaffected.
      const verbose = err instanceof Error ? err.message : String(err);
      await auditLog("admin.backups.restore.failed", {
        userId: admin.id,
        ipAddress: getClientIp(request),
        details: {
          backupId: id,
          ownerId,
          reason: "transaction_failed",
          message: verbose,
        },
      });
      annotate({ meta: { restoreFailReason: verbose } });
      return apiError("Restore failed", 500);
    }

    // v1.4.39.1 — re-fold the persistent measurement rollup tier from
    // the just-restored measurements. Pre-fix the restore left the
    // rollup table empty for the owner, so the dashboard chart's
    // `source=rollup` fast-path silently returned zero buckets until
    // the next worker boot ran the backfill discovery — multi-hour
    // window of empty charts for the operator-restored account. Runs
    // outside the transaction (the 5-year fold would otherwise hold a
    // long write lock) and is best-effort so a populator hiccup never
    // undoes the restore. The boot-time backfill is the safety net.
    if (payload.measurements.length > 0) {
      try {
        await recomputeUserRollups(ownerId);
      } catch (err) {
        annotate({
          meta: {
            measurement_rollup_restore_failed: true,
            measurement_rollup_restore_error:
              err instanceof Error ? err.message : String(err),
          },
        });
      }
    }

    // v1.4.39 W-MOOD — re-fold the mood rollup tier from the just-
    // restored entries. Runs outside the transaction so the (5-year)
    // fold can't hold a long write lock; best-effort so a populator
    // hiccup doesn't undo the restore. The boot-time backfill is the
    // safety net — if this fails the next worker boot mints the rows.
    if (payload.moodEntries.length > 0) {
      try {
        await recomputeUserMoodRollups(ownerId, { granularities: ["DAY"] });
      } catch (err) {
        annotate({
          meta: {
            mood_rollup_restore_failed: true,
            mood_rollup_restore_error:
              err instanceof Error ? err.message : String(err),
          },
        });
      }
    }

    // v1.4.39 W-MED — re-fold the medication-compliance rollup tier
    // from the restored intake events. The medication delete inside the
    // transaction already cascaded the existing rollup partition for
    // this owner via the FK, so the fold mints fresh rows. Boot-time
    // backfill is the safety net if this best-effort call fails.
    if (payload.intakeEvents.length > 0) {
      try {
        const restoreUser = await prisma.user.findUnique({
          where: { id: ownerId },
          select: { timezone: true },
        });
        await recomputeUserMedicationCompliance(
          ownerId,
          MEDICATION_COMPLIANCE_BACKFILL_DAYS,
          restoreUser?.timezone ?? null,
        );
      } catch (err) {
        annotate({
          meta: {
            medication_compliance_rollup_restore_failed: true,
            medication_compliance_rollup_restore_error:
              err instanceof Error ? err.message : String(err),
          },
        });
      }
    }

    const summary = summarizeBackup(payload);

    await auditLog("admin.backups.restore", {
      userId: admin.id,
      ipAddress: getClientIp(request),
      details: {
        backupId: id,
        ownerId,
        ownerUsername: owner.username,
        cleared,
        restored: {
          measurements: summary.measurements,
          medications: summary.medications,
          intakeEvents: summary.intakeEvents,
          moodEntries: summary.moodEntries,
          cycles: summary.cycles,
          cycleDayLogs: summary.cycleDayLogs,
          labResults: summary.labResults,
          biomarkers: summary.biomarkers,
          illnessEpisodes: summary.illnessEpisodes,
          illnessDayLogs: summary.illnessDayLogs,
          allergies: summary.allergies,
          familyHistory: summary.familyHistory,
          workouts: summary.workouts,
          documents: summary.documents,
        },
      },
    });

    // The complete transaction succeeded; only now evict owner-scoped caches.
    invalidateUserData(ownerId);

    const response: RestoreResponse = {
      restored: true,
      summary,
      cleared,
    };
    return apiSuccess(response);
  },
);

// `withIdempotency` wraps the apiHandler so a duplicate retry with the
// same `Idempotency-Key` replays the original 200 instead of executing
// the destructive transaction twice. The default resolver picks up
// either the cookie session OR a Bearer token; for an admin endpoint
// only cookie sessions ever get past `requireAdmin()` upstream, but
// keeping the default keeps the contract uniform.
export const POST = withIdempotency(handler, async () => {
  return defaultUserIdResolver();
});
