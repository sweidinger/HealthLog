import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { apiError, getClientIp } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  toCSV,
  formatMeasurementsForExport,
  formatMedicationsForExport,
  formatIntakeEventsForExport,
  formatMoodEntriesForExport,
} from "@/lib/export";
import { shapeMeasurementNotes, shapeMoodNote } from "@/lib/crypto/note-cipher";
import { findMeasurementsPaged } from "@/lib/export/paged-measurements";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { NextRequest, NextResponse } from "next/server";

/**
 * Export user data.
 * Query params:
 *   format: "csv" | "json" (default: json)
 *   type: "measurements" | "medications" | "intake" | "all" (default: all)
 *
 * Re-authentication is required via session (user must be logged in).
 */
export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const rl = await checkRateLimit(`export:${user.id}`, 10, 60 * 60 * 1000);
  if (!rl.allowed) {
    return apiError("Maximum 10 exports per hour", 429);
  }

  annotate({ action: { name: "export.download" } });

  const { searchParams } = new URL(request.url);
  const format = searchParams.get("format") ?? "json";
  const type = searchParams.get("type") ?? "all";

  if (!["csv", "json"].includes(format)) {
    return apiError("Format must be csv or json", 422);
  }
  if (
    !["measurements", "medications", "intake", "mood", "all"].includes(type)
  ) {
    return apiError(
      "Type must be measurements, medications, intake, mood, or all",
      422,
    );
  }

  const userId = user.id;
  const [userTz, sourcePriorityJson] = await Promise.all([
    resolveUserTimezone(userId),
    loadUserSourcePriority(userId),
  ]);

  const data: Record<string, unknown> = {};

  if (type === "measurements" || type === "all") {
    // v1.28.25 — keyset-paginated read with a narrow select. The legacy
    // export has no date window, so a CGM / per-sample-HR account holds a
    // six-figure row set; one unbounded full-width `findMany` here was the
    // scale hazard. The select carries exactly the fields the formatter +
    // note decryption consume (`ExportMeasurement` + `shapeMeasurementNotes`
    // + the `id` cursor key) — no Bytes column beyond the note ciphertext
    // the export must decrypt.
    const measurements = await findMeasurementsPaged(
      prisma,
      // v1.4.41 W-DELETED-2 — exclude soft-deleted measurements from
      // the legacy /api/export endpoint so CSV + JSON downloads stay
      // consistent with the live measurement reads.
      { userId, deletedAt: null },
      {
        id: true,
        type: true,
        value: true,
        unit: true,
        measuredAt: true,
        source: true,
        notes: true,
        notesEncrypted: true,
        glucoseContext: true,
        sleepStage: true,
        deviceType: true,
      },
    );
    // v1.11.5 — sleep collapses to one row per night by default (the
    // formatter's `night` granularity), matching the per-type CSV route.
    // Thread the user's source-priority so a multi-source night dedups to
    // the same canonical source the UI shows.
    const measurementRecords = formatMeasurementsForExport(
      // v1.23 — decrypt notes before formatting; strip the ciphertext column.
      measurements.map(shapeMeasurementNotes),
      userTz,
      { sleepTz: userTz, sourcePriorityJson },
    );
    data.measurements =
      format === "csv" ? toCSV(measurementRecords) : measurementRecords;
  }

  if (type === "medications" || type === "all") {
    const medications = await prisma.medication.findMany({
      where: { userId },
      include: { schedules: true },
      orderBy: { createdAt: "desc" },
    });
    data.medications =
      format === "csv"
        ? toCSV(formatMedicationsForExport(medications))
        : formatMedicationsForExport(medications);
  }

  if (type === "intake" || type === "all") {
    const events = await prisma.medicationIntakeEvent.findMany({
      // v1.7.0 sync — exclude tombstoned rows from the export (mirrors
      // the measurement export's `deletedAt: null` filter above).
      where: { userId, deletedAt: null },
      include: { medication: { select: { name: true } } },
      orderBy: { scheduledFor: "desc" },
    });
    data.intakeEvents =
      format === "csv"
        ? toCSV(formatIntakeEventsForExport(events, userTz))
        : formatIntakeEventsForExport(events, userTz);
  }

  if (type === "mood" || type === "all") {
    const moodEntries = await prisma.moodEntry.findMany({
      // v1.7.0 sync — exclude tombstoned rows from the export.
      where: { userId, deletedAt: null },
      orderBy: { moodLoggedAt: "desc" },
    });
    const decryptedMood = moodEntries.map(shapeMoodNote);
    data.moodEntries =
      format === "csv"
        ? toCSV(formatMoodEntriesForExport(decryptedMood, userTz))
        : formatMoodEntriesForExport(decryptedMood, userTz);
  }

  await auditLog("export.download", {
    userId,
    ipAddress: getClientIp(request),
    details: { format, type },
  });

  annotate({ meta: { export_format: format, export_type: type } });

  if (format === "csv") {
    // For CSV with all types, combine into separate sections
    const csvParts: string[] = [];
    if (data.measurements) {
      csvParts.push("# Measurements\n" + data.measurements);
    }
    if (data.medications) {
      csvParts.push("# Medications\n" + data.medications);
    }
    if (data.intakeEvents) {
      csvParts.push("# Intake Events\n" + data.intakeEvents);
    }
    if (data.moodEntries) {
      csvParts.push("# Mood Entries\n" + data.moodEntries);
    }
    const csvContent = csvParts.join("\n\n");

    return new NextResponse(csvContent, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="healthlog-export-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  }

  return NextResponse.json(
    { data },
    {
      status: 200,
      headers: {
        "Content-Disposition": `attachment; filename="healthlog-export-${new Date().toISOString().slice(0, 10)}.json"`,
      },
    },
  );
});
