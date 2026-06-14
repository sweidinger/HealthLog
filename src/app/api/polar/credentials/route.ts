import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, apiError, safeJson } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import {
  storePolarClientCredentials,
  clearPolarClientCredentials,
} from "@/lib/polar/credentials";
import { polarCredentialsSchema } from "@/lib/validations/polar";
import { NextRequest } from "next/server";
import { z } from "zod/v4";

/**
 * v1.17.1 — per-user Polar BYO-key credentials.
 *
 * Whether the user has their own Polar AccessLink client id/secret stored. The
 * connect/callback/status routes resolve credentials DB-first then env, so an
 * unset pair simply falls back to the shared env app.
 */
export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "polar.credentials.get" } });

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      polarClientIdEncrypted: true,
      polarClientSecretEncrypted: true,
    },
  });

  return apiSuccess({
    hasCredentials:
      !!dbUser?.polarClientIdEncrypted && !!dbUser?.polarClientSecretEncrypted,
  });
});

/**
 * Save Polar OAuth client credentials (encrypted at rest).
 */
export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "polar.credentials.update" } });

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });
  if (jsonError) return jsonError;

  const result = z.safeParse(polarCredentialsSchema, body);
  if (!result.success) {
    return apiError("Client ID and Client Secret are required", 422);
  }

  await storePolarClientCredentials(
    user.id,
    result.data.clientId,
    result.data.clientSecret,
  );

  return apiSuccess({ updated: true });
});

/**
 * Delete Polar credentials and the active connection.
 */
export const DELETE = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "polar.credentials.delete" } });

  await prisma.user.update({
    where: { id: user.id },
    data: {
      polarAccessTokenEncrypted: null,
      polarUserIdEncrypted: null,
    },
  });
  await clearPolarClientCredentials(user.id);

  return apiSuccess({ deleted: true });
});
