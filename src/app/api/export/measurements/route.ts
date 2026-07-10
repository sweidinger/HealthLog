/**
 * GET /api/export/measurements
 *
 * v1.4.16 phase B7. Per-type CSV download for the consolidated
 * `/settings/export` UI. Filterable by `since` / `until` (inclusive
 * date strings parsed via the standard Date constructor — invalid
 * values are silently dropped from the where-clause).
 *
 * Response is `text/csv` with an attachment filename ending in `.csv`,
 * so the browser writes a `.csv` file even though the route segment
 * itself doesn't carry the extension (Next.js + vitest can't resolve
 * dotted route segments cleanly — see commit log for context).
 *
 * Auth: cookie session OR Bearer token (`requireAuth`).
 * Rate-limit: shared `export:<userId>` bucket (10/h) so the user can't
 *   sidestep the global cap by hitting per-type endpoints in parallel.
 * Audit: `user.export.measurements` with the resolved filter.
 */
import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { apiError, getClientIp } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { toCSV, formatMeasurementsForExport } from "@/lib/export";
import { findMeasurementsPaged } from "@/lib/export/paged-measurements";
import { shapeMeasurementNotes } from "@/lib/crypto/note-cipher";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { resolveGlucoseUnit } from "@/lib/glucose";
import { NextRequest, NextResponse } from "next/server";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "user.export.measurements" } });

  const rl = await checkRateLimit(`export:${user.id}`, 10, 60 * 60 * 1000);
  if (!rl.allowed) {
    return apiError("Maximum 10 exports per hour", 429);
  }

  const { since, until } = parseRange(request.url);
  const where = buildWhere(user.id, { since, until });
  // v1.11.5 — sleep export defaults to one row per night; `granularity=raw`
  // keeps the per-stage rows for power users.
  const granularity =
    new URL(request.url).searchParams.get("granularity") === "raw"
      ? "raw"
      : "night";

  const [measurements, userTz, sourcePriorityJson, profile] = await Promise.all(
    [
      // v1.28.25 — keyset-paginated read with a narrow select. The route
      // keeps its contract (an absent `since`/`until` means the full
      // history), but the read is now chunked so an unbounded window on a
      // CGM / per-sample-HR account never materialises the whole table in
      // one query. The select is exactly the formatter's `ExportMeasurement`
      // shape + note decryption + the `id` cursor key.
      findMeasurementsPaged(prisma, where, {
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
      }),
      resolveUserTimezone(user.id),
      loadUserSourcePriority(user.id),
      // v1.16.16 — resolve the glucose display unit so BLOOD_GLUCOSE rows
      // export in the user's unit (matching FHIR), not raw stored mg/dL.
      prisma.user.findUnique({
        where: { id: user.id },
        select: { glucoseUnit: true },
      }),
    ],
  );
  const glucoseUnit = resolveGlucoseUnit(profile?.glucoseUnit ?? null);

  const csv = toCSV(
    formatMeasurementsForExport(
      measurements.map(shapeMeasurementNotes),
      userTz,
      {
        granularity,
        sleepTz: userTz,
        sourcePriorityJson,
        glucoseUnit,
      },
    ),
  );

  await auditLog("user.export.measurements", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      count: measurements.length,
      since: since?.toISOString() ?? null,
      until: until?.toISOString() ?? null,
    },
  });

  annotate({
    meta: {
      export_count: measurements.length,
      export_since: since?.toISOString() ?? null,
      export_until: until?.toISOString() ?? null,
    },
  });

  return csvResponse(csv, `healthlog-measurements-${user.id}`);
});

function parseRange(url: string): {
  since: Date | undefined;
  until: Date | undefined;
} {
  const params = new URL(url).searchParams;
  const sinceRaw = params.get("since");
  const untilRaw = params.get("until");
  const since = sinceRaw ? safeDate(sinceRaw) : undefined;
  const until = untilRaw ? safeDate(untilRaw) : undefined;
  return { since, until };
}

function safeDate(value: string): Date | undefined {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function buildWhere(
  userId: string,
  range: { since?: Date; until?: Date },
): {
  userId: string;
  deletedAt: null;
  measuredAt?: { gte?: Date; lte?: Date };
} {
  // v1.4.41 W-DELETED-2 — soft-deleted measurements stay out of every
  // per-type CSV download so an undo or pending-sync row never reaches
  // the user's local file.
  const where: {
    userId: string;
    deletedAt: null;
    measuredAt?: { gte?: Date; lte?: Date };
  } = {
    userId,
    deletedAt: null,
  };
  if (range.since || range.until) {
    where.measuredAt = {};
    if (range.since) where.measuredAt.gte = range.since;
    if (range.until) where.measuredAt.lte = range.until;
  }
  return where;
}

function csvResponse(body: string, prefix: string): NextResponse {
  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${prefix}-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
