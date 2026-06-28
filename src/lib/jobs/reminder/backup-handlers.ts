/**
 * Weekly on-host data backup and the nightly off-host backup handler.
 *
 * Extracted from reminder-worker.ts, which owns the queue names, cron
 * schedules, and boss.work registrations.
 */
import { type Job } from "pg-boss";
import { recordError } from "@/lib/jobs/worker-status";
import { encrypt } from "@/lib/crypto";
import { withBackgroundEvent } from "@/lib/logging/background";
import { buildCycleBackupSection } from "@/lib/cycle/backup";
import { runOffhostBackup } from "@/lib/jobs/offhost-backup";
import {
  collectPagedMeasurements,
  MEASUREMENT_BACKUP_PAGE_SIZE,
  sortWeeklyMeasurementsDesc,
  toWeeklyBackupMeasurement,
} from "@/lib/jobs/backup/measurement-page";
import { getWorkerPrisma } from "./shared";

export interface DataBackupPayload {
  triggeredAt: string;
}

export interface OffhostBackupPayload {
  triggeredAt: string;
}

export async function handleOffhostBackup(jobs: Job<OffhostBackupPayload>[]) {
  void jobs;
  await withBackgroundEvent("job.offhost_backup", async (evt) => {
    const p = getWorkerPrisma();
    try {
      const report = await runOffhostBackup(p);
      evt.addMeta("offhost_backup_uploaded", report.uploaded);
      evt.addMeta("offhost_backup_failed", report.failed);
      evt.addMeta("offhost_backup_total_users", report.totalUsers);
      evt.addMeta("offhost_backup_endpoint", report.config.endpoint);
      evt.addMeta("offhost_backup_bucket", report.config.bucket);
      // Per-user failure detail is also emitted as warnings inside
      // runOffhostBackup; echo a structured digest for at-a-glance triage.
      if (report.failures.length > 0) {
        evt.addMeta(
          "offhost_backup_failures",
          JSON.stringify(report.failures.slice(0, 10)),
        );
      }
    } catch (err) {
      // Not configured ⇒ skip silently with a warning, not an error.
      evt.addWarning(`offhost-backup skipped/failed: ${err}`);
    }
  });
}

export async function handleDataBackup(jobs: Job<DataBackupPayload>[]) {
  void jobs;
  await withBackgroundEvent("job.data_backup", async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      const users = await prisma.user.findMany({
        select: { id: true, username: true },
      });

      let backed = 0;
      for (const user of users) {
        try {
          const [measurements, medications, intakeEvents, moodEntries, cycle] =
            await Promise.all([
              // Keyset-paged narrow read instead of one full-set
              // findMany + map: a heavy multi-year tenant otherwise
              // loads every measurement ORM row into a single array
              // alongside the giant JSON.stringify below, the worker's
              // dominant heap spike. The page reader projects each page
              // to the compact backup shape before the next page loads,
              // bounding peak heap to the page size. Row scope is
              // unchanged — no `deletedAt` filter, so tombstoned rows
              // still round-trip exactly as before. The order is
              // restored to measuredAt-desc to match the prior output.
              collectPagedMeasurements({
                fetchPage: (afterId, take) =>
                  prisma.measurement.findMany({
                    where: {
                      userId: user.id,
                      ...(afterId ? { id: { gt: afterId } } : {}),
                    },
                    // Exactly the columns the admin restore recreates a
                    // row from, plus `id` for the keyset cursor.
                    select: {
                      id: true,
                      type: true,
                      value: true,
                      unit: true,
                      source: true,
                      measuredAt: true,
                      notes: true,
                      notesEncrypted: true,
                    },
                    orderBy: { id: "asc" },
                    take,
                  }),
                project: toWeeklyBackupMeasurement,
                pageSize: MEASUREMENT_BACKUP_PAGE_SIZE,
              }).then(sortWeeklyMeasurementsDesc),
              prisma.medication.findMany({
                where: { userId: user.id },
                include: { schedules: true },
              }),
              prisma.medicationIntakeEvent.findMany({
                where: { userId: user.id },
                include: { medication: { select: { name: true } } },
                orderBy: { scheduledFor: "desc" },
              }),
              prisma.moodEntry.findMany({
                where: { userId: user.id },
                orderBy: { moodLoggedAt: "desc" },
              }),
              // v1.15.0 — cycle slice (shared helper, notesEncrypted verbatim).
              buildCycleBackupSection(prisma, user.id),
            ]);

          const backupJson = JSON.stringify({
            // Bumped only when the on-disk shape changes incompatibly.
            // Mirrors `BACKUP_SCHEMA_VERSION` in
            // `src/lib/validations/backup.ts` — keep them in sync.
            schemaVersion: "1",
            exportedAt: new Date().toISOString(),
            userId: user.id,
            // Already projected + ordered by the paged reader above; the
            // decrypted note rode into each row so an admin restore
            // re-encrypts on re-insert (v1.23 contract).
            measurements,
            medications: medications.map((m) => ({
              name: m.name,
              dose: m.dose,
              active: m.active,
              schedules: m.schedules.map((s) => ({
                windowStart: s.windowStart,
                windowEnd: s.windowEnd,
                label: s.label,
                dose: s.dose,
              })),
            })),
            intakeEvents: intakeEvents.map((e) => ({
              medication: e.medication.name,
              scheduledFor: e.scheduledFor.toISOString(),
              takenAt: e.takenAt?.toISOString() ?? null,
              skipped: e.skipped,
              source: e.source,
            })),
            moodEntries: moodEntries.map((e) => ({
              date: e.date,
              mood: e.mood,
              score: e.score,
              tags: e.tags,
              source: e.source,
              loggedAt: e.moodLoggedAt.toISOString(),
            })),
            // v1.15.0 — cycle slice (profile + observed spans + day-logs).
            cycleProfile: cycle.cycleProfile,
            cycles: cycle.cycles,
            cycleDayLogs: cycle.cycleDayLogs,
          });

          // Encrypt the backup data (contains sensitive health information)
          const encryptedBackup = encrypt(backupJson);

          await prisma.dataBackup.upsert({
            where: {
              userId_type: { userId: user.id, type: "WEEKLY_AUTO" },
            },
            update: {
              data: encryptedBackup,
              createdAt: new Date(),
            },
            create: {
              userId: user.id,
              type: "WEEKLY_AUTO",
              data: encryptedBackup,
            },
          });
          backed++;
        } catch (err) {
          evt.addWarning(`Failed for user ${user.id}: ${err}`);
        }
      }

      evt.setBackground({
        task_name: "job.data_backup",
        result: { backed, total: users.length },
      });
    } catch (err) {
      evt.setError(err);
      recordError();
      throw err;
    }
  });
}
