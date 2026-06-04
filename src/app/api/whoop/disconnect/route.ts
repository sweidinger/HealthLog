import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { markDisconnected } from "@/lib/integrations/status";

/**
 * Disconnect the WHOOP integration for the current user (v1.11.0).
 *
 * Clears the stored OAuth tokens by deleting the `WhoopConnection` row and
 * parks the integration status at `disconnected`. WHOOP webhook subscriptions
 * are app-level (registered once per dev app), so there is no per-user
 * unsubscribe call to make — unlike Withings, which subscribes per category.
 * The BYO-key credentials on `User` are left intact so a reconnect doesn't
 * force the user to re-paste them; use the credentials DELETE endpoint to
 * remove those too.
 */
export const POST = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "whoop.disconnect" } });

  const connection = await prisma.whoopConnection.findUnique({
    where: { userId: user.id },
  });

  if (!connection) {
    return apiError("No WHOOP connection", 404);
  }

  await prisma.whoopConnection.delete({
    where: { userId: user.id },
  });

  await auditLog("whoop.disconnect", {
    userId: user.id,
  });

  await markDisconnected(user.id, "whoop");

  return apiSuccess({ disconnected: true });
});
