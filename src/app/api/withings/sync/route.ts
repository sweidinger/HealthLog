import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { syncUserMeasurements } from "@/lib/withings/sync";
import { NextRequest } from "next/server";

/**
 * Manually trigger a Withings sync for the current user.
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "withings.sync" } });

  let fullSync = false;
  try {
    const body = await request.json();
    fullSync = body?.fullSync === true;
  } catch {
    // no body provided -> default incremental sync
  }

  const imported = await syncUserMeasurements(user.id, {
    fullSync,
  });
  return apiSuccess({ imported, fullSync });
});
