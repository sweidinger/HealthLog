import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { NextRequest } from "next/server";
import {
  collectDoctorReportData,
  normaliseDateRange,
} from "@/lib/doctor-report-data";

/**
 * Collect data for doctor report PDF generation (client-side).
 * Returns aggregated health data for the specified time range.
 *
 * Body shape (all fields optional — sensible defaults apply):
 *   {
 *     startDate?: string,  // ISO timestamp, inclusive
 *     endDate?: string,    // ISO timestamp, inclusive
 *     days?: number        // legacy "last N days" fallback (1..365)
 *   }
 *
 * Resolution: explicit range wins; otherwise `days` (default 90) is applied.
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "doctor-report.generate" } });

  const rl = await checkRateLimit(
    `doctor-report:${user.id}`,
    10,
    60 * 60 * 1000,
  );
  if (!rl.allowed) {
    return apiError("Maximum 10 reports per hour", 429);
  }

  const { data: body, error: jsonError } = await safeJson(request);
  if (jsonError) return jsonError;

  const range = normaliseDateRange(body);
  const data = await collectDoctorReportData(user.id, range);

  await auditLog("doctor-report.generate", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      days: range.days,
      startDate: range.start.toISOString(),
      endDate: range.end.toISOString(),
    },
  });

  annotate({
    meta: {
      report_days: range.days,
      report_start: range.start.toISOString(),
      report_end: range.end.toISOString(),
    },
  });

  return apiSuccess(data);
});
