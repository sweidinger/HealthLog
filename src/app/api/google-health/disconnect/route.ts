import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { markDisconnected } from "@/lib/integrations/status";

/**
 * Disconnect the Google Health integration for the current user (v1.26.0).
 *
 * Clears the stored OAuth tokens by deleting the `GoogleHealthConnection` row
 * and parks the integration status at `disconnected`. There is no per-user
 * subscription to tear down (Google Health is poll-only at launch — no Pub/Sub
 * push), so no upstream unsubscribe call is needed; deleting the encrypted
 * token pair is the effective revocation. The BYO-key credentials on `User` are
 * left intact so a reconnect doesn't force the user to re-paste them; use the
 * credentials DELETE endpoint to remove those too.
 */
export const POST = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "google_health.disconnect" } });

  const connection = await prisma.googleHealthConnection.findUnique({
    where: { userId: user.id },
  });

  if (!connection) {
    return apiError("No Google Health connection", 404);
  }

  await prisma.googleHealthConnection.delete({
    where: { userId: user.id },
  });

  await auditLog("google_health.disconnect", {
    userId: user.id,
  });

  await markDisconnected(user.id, "google-health");

  return apiSuccess({ disconnected: true });
});
