import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, apiError, safeJson } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { encrypt } from "@/lib/crypto";
import { withingsCredentialsSchema } from "@/lib/validations/withings";
import { NextRequest } from "next/server";
import { z } from "zod/v4";

/**
 * Check if user has Withings credentials stored.
 */
export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "withings.credentials.get" } });

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      withingsClientIdEncrypted: true,
      withingsClientSecretEncrypted: true,
    },
  });

  return apiSuccess({
    hasCredentials:
      !!dbUser?.withingsClientIdEncrypted &&
      !!dbUser?.withingsClientSecretEncrypted,
  });
});

/**
 * Save Withings API credentials (encrypted).
 */
export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "withings.credentials.update" } });

  const { data: body, error: jsonError } = await safeJson(request);

  if (jsonError) return jsonError;
  const result = z.safeParse(withingsCredentialsSchema, body);
  if (!result.success) {
    return apiError("Client ID and Client Secret are required", 422);
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      withingsClientIdEncrypted: encrypt(result.data.clientId),
      withingsClientSecretEncrypted: encrypt(result.data.clientSecret),
    },
  });

  return apiSuccess({ updated: true });
});

/**
 * Delete Withings credentials and disconnect.
 */
export const DELETE = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "withings.credentials.delete" } });

  // Remove connection first
  await prisma.withingsConnection
    .delete({ where: { userId: user.id } })
    .catch(() => {});

  // Remove credentials
  await prisma.user.update({
    where: { id: user.id },
    data: {
      withingsClientIdEncrypted: null,
      withingsClientSecretEncrypted: null,
    },
  });

  return apiSuccess({ deleted: true });
});
