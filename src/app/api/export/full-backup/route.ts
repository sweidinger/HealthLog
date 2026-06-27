/**
 * GET /api/export/full-backup
 *
 * v1.4.16 phase B7. Single-file user-scoped JSON dump that matches the
 * canonical `backupPayloadSchema` (see `src/lib/validations/backup.ts`)
 * — same shape the pg-boss `data-backup` worker writes weekly, so a
 * user can hand this file to an admin and `POST /api/admin/backups/upload`
 * accepts it without further conversion.
 *
 * Response is `application/json` with an attachment filename ending in
 * `.json` so the browser writes a `.json` file even though the route
 * segment doesn't carry the extension.
 *
 * Auth: cookie session OR Bearer token (`requireAuth`).
 * Rate-limit: shared `export:<userId>` bucket (10/h).
 * Audit: `user.export.full-backup` with the row counts.
 */
import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { apiError, getClientIp } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { buildFullBackupPayload } from "@/lib/export/full-backup-payload";
import { NextRequest, NextResponse } from "next/server";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "user.export.full-backup" } });

  const rl = await checkRateLimit(`export:${user.id}`, 10, 60 * 60 * 1000);
  if (!rl.allowed) {
    return apiError("Maximum 10 exports per hour", 429);
  }

  // v1.23 — the payload builder is shared with the passphrase-encrypted
  // export route so both emit the byte-for-byte same restore-compatible shape.
  const { payload, counts } = await buildFullBackupPayload(prisma, user.id);

  await auditLog("user.export.full-backup", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { counts },
  });

  annotate({
    meta: {
      export_measurements_count: counts.measurements,
      export_medications_count: counts.medications,
      export_intake_count: counts.intakeEvents,
      export_mood_count: counts.moodEntries,
      export_cycle_count: counts.cycles,
      export_cycle_day_log_count: counts.cycleDayLogs,
    },
  });

  const stamp = new Date().toISOString().slice(0, 10);
  // Stream the JSON directly (NOT wrapped in the apiSuccess envelope) so
  // the file is a self-contained backup — admin upload + restore expect
  // the raw payload, not `{ data: { ... } }`.
  return new NextResponse(JSON.stringify(payload), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="healthlog-backup-${user.id}-${stamp}.json"`,
      "Cache-Control": "no-store",
    },
  });
});
