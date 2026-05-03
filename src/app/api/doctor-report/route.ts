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
  normaliseDays,
} from "@/lib/doctor-report-data";

/**
 * Collect data for doctor report PDF generation (client-side).
 * Returns aggregated health data for the specified time range.
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

  const days = normaliseDays((body as Record<string, unknown>)?.days);
  const data = await collectDoctorReportData(user.id, days);

  await auditLog("doctor-report.generate", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { days },
  });

  annotate({ meta: { report_days: days } });

  return apiSuccess(data);
});
