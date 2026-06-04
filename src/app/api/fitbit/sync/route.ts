import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { syncUserFitbit } from "@/lib/fitbit/sync";
import { NextRequest } from "next/server";

/**
 * Manually trigger a Fitbit / Google Health sync for the current user (v1.12.0).
 *
 * Mirrors the WHOOP manual-sync route: incremental by default, full history when
 * `{ fullSync: true }` is posted.
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "fitbit.sync" } });

  let fullSync = false;
  try {
    const body = await request.json();
    fullSync = body?.fullSync === true;
  } catch {
    // no body provided -> default incremental sync
  }

  const imported = await syncUserFitbit(user.id, { fullSync });
  return apiSuccess({ imported, fullSync });
});
