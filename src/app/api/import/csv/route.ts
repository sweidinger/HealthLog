import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { NextRequest } from "next/server";

import {
  parseCsvMeasurements,
  type CsvRowResult,
} from "@/lib/import/csv-measurements";
import {
  collapseToTypeDayKeys,
  recomputeBucketsForMeasurement,
} from "@/lib/rollups/measurement-rollups";
import type {
  MeasurementType,
  GlucoseContext,
} from "@/generated/prisma/client";

/**
 * CSV measurement import (v1.17.1).
 *
 * The cold-start escape hatch for self-hosters migrating from a spreadsheet
 * or another tracker. Reuses the `/api/import` write loop + rollup re-fold;
 * the parse + per-row validation + unit conversion lives in the pure
 * `parseCsvMeasurements` module so it is unit-tested without a database.
 *
 * Body is `text/csv` (or `text/plain`) raw text — NOT JSON. Capped at 16 MB
 * (the same ceiling as the JSON import; a 16 MB CSV is > 100 000 rows). Rows
 * beyond the 10 000 ceiling are rejected so the rollup re-fold stays bounded.
 *
 * `?dryRun=1` parses + validates + returns the per-row status envelope
 * WITHOUT writing — a trust win for a bulk cold-start import.
 *
 * Response: `{ inserted, updated, skipped, total, dryRun, rows: [{line,
 * status, reason}] }`, mirroring the batch route's per-entry envelope.
 */

const MAX_CSV_BYTES = 16 * 1024 * 1024;
const MAX_ROWS = 10000;

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "import.csv.upload" } });

  const dryRun =
    new URL(request.url).searchParams.get("dryRun") === "1" ||
    new URL(request.url).searchParams.get("dryRun") === "true";

  // Same blast-radius reasoning as the JSON import — share the bucket so a
  // CSV upload counts against the same 5/hour quota.
  const rl = await checkRateLimit(`import:${user.id}`, 5, 60 * 60 * 1000);
  if (!rl.allowed) {
    return apiError("Maximum 5 imports per hour", 429);
  }

  // Raw text read with an explicit byte cap — `safeJson` is JSON-only, so we
  // enforce the same `maxBytes` ceiling here against the Content-Length and
  // the materialised body.
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CSV_BYTES) {
    return apiError("CSV exceeds the 16 MB limit", 413);
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return apiError("Could not read the request body", 400);
  }
  if (Buffer.byteLength(text, "utf8") > MAX_CSV_BYTES) {
    return apiError("CSV exceeds the 16 MB limit", 413);
  }

  const parsed = parseCsvMeasurements(text);
  if (parsed.fatal) {
    return apiError(parsed.fatal.message, 422);
  }

  const okRows = parsed.rows.filter(
    (r): r is CsvRowResult & { row: NonNullable<CsvRowResult["row"]> } =>
      r.status === "ok" && r.row !== undefined,
  );
  if (okRows.length > MAX_ROWS) {
    return apiError(
      `CSV has ${okRows.length} valid rows — the limit is ${MAX_ROWS} per import`,
      422,
    );
  }

  const userId = user.id;
  let inserted = 0;
  let updated = 0;
  let skipped = parsed.rows.filter((r) => r.status === "skipped").length;

  const touchedMeasurements: Array<{
    type: MeasurementType;
    measuredAt: Date;
  }> = [];

  // Per-line write outcome for rows that reached the DB. Keyed by source line
  // so the response envelope can surface `inserted` / `updated` / `duplicate`
  // distinctly without polluting the parse-time `CsvRowReason`.
  const writeOutcome = new Map<number, "inserted" | "updated" | "duplicate">();

  if (!dryRun) {
    for (const result of okRows) {
      const m = result.row;
      try {
        if (m.externalId) {
          // Idempotent re-import keyed on the source-stable id — re-uploading
          // the same file updates in place rather than minting duplicates.
          const res = await prisma.measurement.upsert({
            where: {
              userId_type_source_externalId: {
                userId,
                type: m.type as MeasurementType,
                source: "IMPORT",
                externalId: m.externalId,
              },
            },
            update: {
              value: m.value,
              unit: m.unit,
              measuredAt: m.measuredAt,
              notes: m.notes ?? null,
              glucoseContext:
                (m.glucoseContext as GlucoseContext | undefined) ?? null,
            },
            create: {
              userId,
              type: m.type as MeasurementType,
              value: m.value,
              unit: m.unit,
              source: "IMPORT",
              externalId: m.externalId,
              measuredAt: m.measuredAt,
              notes: m.notes ?? null,
              glucoseContext:
                (m.glucoseContext as GlucoseContext | undefined) ?? null,
            },
            select: { createdAt: true, updatedAt: true },
          });
          // A fresh create has createdAt === updatedAt; an in-place update
          // bumps updatedAt past createdAt.
          if (res.updatedAt.getTime() > res.createdAt.getTime()) {
            updated++;
            writeOutcome.set(result.line, "updated");
          } else {
            inserted++;
            writeOutcome.set(result.line, "inserted");
          }
        } else {
          await prisma.measurement.create({
            data: {
              userId,
              type: m.type as MeasurementType,
              value: m.value,
              unit: m.unit,
              source: "IMPORT",
              measuredAt: m.measuredAt,
              notes: m.notes ?? null,
              glucoseContext:
                (m.glucoseContext as GlucoseContext | undefined) ?? null,
            },
          });
          inserted++;
          writeOutcome.set(result.line, "inserted");
        }
        touchedMeasurements.push({
          type: m.type as MeasurementType,
          measuredAt: m.measuredAt,
        });
      } catch {
        // Unique-constraint violation (a NULL-externalId duplicate against an
        // existing row) — count as skipped rather than failing the file.
        skipped++;
        writeOutcome.set(result.line, "duplicate");
      }
    }

    // One bounded rollup re-fold per touched (type, day) — a 10 000-row CSV
    // pays at most ~N (type, day) recomputes, not 10 000 per-row hooks.
    // Best-effort: a populator hiccup never fails the importer.
    if (touchedMeasurements.length > 0) {
      try {
        const keys = collapseToTypeDayKeys(touchedMeasurements);
        for (const k of keys) {
          await recomputeBucketsForMeasurement(userId, k.type, k.measuredAt);
        }
      } catch (err) {
        annotate({
          meta: {
            measurement_rollup_csv_import_failed: true,
            measurement_rollup_csv_import_error:
              err instanceof Error ? err.message : String(err),
          },
        });
      }
    }

    await auditLog("import.csv.upload", {
      userId,
      ipAddress: getClientIp(request),
      details: { inserted, updated, skipped },
    });
  } else {
    // Dry-run preview: no write ran, so report the projected outcome —
    // every valid parse-`ok` row would insert (an externalId row could land
    // as an update, but that needs a DB read we deliberately skip here).
    inserted = okRows.length;
  }

  const summary = {
    inserted,
    updated,
    skipped,
    total: parsed.rows.length,
    dryRun,
    // Per-row status, mirroring the batch route's per-entry envelope. The
    // normalised payload is stripped — the client only needs line + status.
    // Parse-time `ok` rows are refined by the write outcome: a row that hit a
    // unique-constraint duplicate becomes `skipped`/`duplicate`; an upsert
    // that landed on an existing row becomes `updated`. In `dryRun` mode no
    // write ran, so every parse-`ok` row stays `inserted` (the projected
    // outcome).
    rows: parsed.rows.map((r) => {
      if (r.status === "skipped") {
        return {
          line: r.line,
          status: "skipped" as const,
          ...(r.reason ? { reason: r.reason } : {}),
        };
      }
      const outcome = writeOutcome.get(r.line);
      if (outcome === "duplicate") {
        return {
          line: r.line,
          status: "skipped" as const,
          reason: "duplicate",
        };
      }
      if (outcome === "updated") {
        return { line: r.line, status: "updated" as const };
      }
      return { line: r.line, status: "inserted" as const };
    }),
  };

  annotate({
    meta: {
      import_csv_inserted: inserted,
      import_csv_updated: updated,
      import_csv_skipped: skipped,
      import_csv_dry_run: dryRun,
    },
  });

  return apiSuccess(summary);
});
