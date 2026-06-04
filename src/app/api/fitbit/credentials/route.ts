import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, apiError, safeJson } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { encrypt } from "@/lib/crypto";
import { fitbitCredentialsSchema } from "@/lib/validations/fitbit";
import { NextRequest } from "next/server";
import { z } from "zod/v4";

/**
 * Check whether the user has Fitbit / Google Health BYO-key credentials stored
 * (v1.12.0).
 */
export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "fitbit.credentials.get" } });

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      fitbitClientIdEncrypted: true,
      fitbitClientSecretEncrypted: true,
    },
  });

  return apiSuccess({
    hasCredentials:
      !!dbUser?.fitbitClientIdEncrypted &&
      !!dbUser?.fitbitClientSecretEncrypted,
  });
});

/**
 * Save Fitbit / Google Health API credentials (encrypted at rest).
 */
export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "fitbit.credentials.update" } });

  const { data: body, error: jsonError } = await safeJson(request);
  if (jsonError) return jsonError;

  const result = z.safeParse(fitbitCredentialsSchema, body);
  if (!result.success) {
    return apiError("Client ID and Client Secret are required", 422);
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      fitbitClientIdEncrypted: encrypt(result.data.clientId),
      fitbitClientSecretEncrypted: encrypt(result.data.clientSecret),
    },
  });

  return apiSuccess({ updated: true });
});

/**
 * Delete Fitbit credentials and the active connection.
 */
export const DELETE = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "fitbit.credentials.delete" } });

  await prisma.fitbitConnection
    .delete({ where: { userId: user.id } })
    .catch(() => {});

  await prisma.user.update({
    where: { id: user.id },
    data: {
      fitbitClientIdEncrypted: null,
      fitbitClientSecretEncrypted: null,
    },
  });

  return apiSuccess({ deleted: true });
});
