/**
 * Weekly on-host data backup and the nightly off-host backup handler.
 *
 * Extracted from reminder-worker.ts, which owns the queue names, cron
 * schedules, and boss.work registrations.
 */
import { type Job } from "pg-boss";
import { recordError } from "@/lib/jobs/worker-status";
import { encrypt } from "@/lib/crypto";
import { readNote } from "@/lib/crypto/note-cipher";
import { withBackgroundEvent } from "@/lib/logging/background";
import { buildCycleBackupSection } from "@/lib/cycle/backup";
import { runOffhostBackup } from "@/lib/jobs/offhost-backup";
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
              prisma.measurement.findMany({
                where: { userId: user.id },
                orderBy: { measuredAt: "desc" },
              }),
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
            measurements: measurements.map((m) => ({
              type: m.type,
              value: m.value,
              unit: m.unit,
              measuredAt: m.measuredAt.toISOString(),
              source: m.source,
              // v1.23 — decrypt into the (whole-blob-encrypted) backup payload
              // so an admin restore re-encrypts on re-insert.
              notes: readNote(m.notesEncrypted, m.notes),
            })),
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
