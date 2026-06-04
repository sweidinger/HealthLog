import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { markDisconnected } from "@/lib/integrations/status";

/**
 * Disconnect the Fitbit / Google Health integration for the current user
 * (v1.12.0).
 *
 * Clears the stored OAuth tokens by deleting the `FitbitConnection` row and
 * parks the integration status at `disconnected`. There is no per-user
 * subscription to tear down (Pub/Sub is deferred — poll-only at launch), so no
 * upstream unsubscribe call is needed. The BYO-key credentials on `User` are
 * left intact so a reconnect doesn't force the user to re-paste them; use the
 * credentials DELETE endpoint to remove those too.
 */
export const POST = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "fitbit.disconnect" } });

  const connection = await prisma.fitbitConnection.findUnique({
    where: { userId: user.id },
  });

  if (!connection) {
    return apiError("No Fitbit connection", 404);
  }

  await prisma.fitbitConnection.delete({
    where: { userId: user.id },
  });

  await auditLog("fitbit.disconnect", {
    userId: user.id,
  });

  await markDisconnected(user.id, "fitbit");

  return apiSuccess({ disconnected: true });
});
