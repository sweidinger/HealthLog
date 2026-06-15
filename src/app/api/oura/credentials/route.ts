import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, apiError, safeJson } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { markDisconnected } from "@/lib/integrations/status";
import {
  storeOuraClientCredentials,
  clearOuraClientCredentials,
} from "@/lib/oura/credentials";
import { ouraCredentialsSchema } from "@/lib/validations/oura";
import { NextRequest } from "next/server";
import { z } from "zod/v4";

/**
 * v1.17.1 — per-user Oura BYO-key credentials.
 *
 * Whether the user has their own Oura client id/secret stored. The
 * connect/callback/status routes resolve credentials DB-first then env, so an
 * unset pair simply falls back to the shared env app.
 */
export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "oura.credentials.get" } });

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      ouraClientIdEncrypted: true,
      ouraClientSecretEncrypted: true,
    },
  });

  return apiSuccess({
    hasCredentials:
      !!dbUser?.ouraClientIdEncrypted && !!dbUser?.ouraClientSecretEncrypted,
  });
});

/**
 * Save Oura OAuth client credentials (encrypted at rest).
 */
export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "oura.credentials.update" } });

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });
  if (jsonError) return jsonError;

  const result = z.safeParse(ouraCredentialsSchema, body);
  if (!result.success) {
    return apiError("Client ID and Client Secret are required", 422);
  }

  await storeOuraClientCredentials(
    user.id,
    result.data.clientId,
    result.data.clientSecret,
  );

  return apiSuccess({ updated: true });
});

/**
 * Delete Oura credentials and the active connection.
 *
 * Deleting the BYO credentials drops a live connection (a token minted against
 * the deleted app is now orphaned), so when an access token was present this
 * mirrors `/api/oura/disconnect`: audit the event and park the integration
 * ledger at `disconnected` rather than leaving it stale at its last state.
 */
export const DELETE = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "oura.credentials.delete" } });

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: { ouraAccessTokenEncrypted: true },
  });
  const wasConnected = !!dbUser?.ouraAccessTokenEncrypted;

  await prisma.user.update({
    where: { id: user.id },
    data: {
      ouraAccessTokenEncrypted: null,
      ouraRefreshTokenEncrypted: null,
    },
  });
  await clearOuraClientCredentials(user.id);

  if (wasConnected) {
    await auditLog("oura.credentials.delete", { userId: user.id });
    await markDisconnected(user.id, "oura");
  }

  return apiSuccess({ deleted: true });
});
