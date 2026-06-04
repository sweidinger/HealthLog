import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, apiError, safeJson } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { encrypt } from "@/lib/crypto";
import { whoopCredentialsSchema } from "@/lib/validations/whoop";
import { NextRequest } from "next/server";
import { z } from "zod/v4";

/**
 * Check whether the user has WHOOP BYO-key credentials stored (v1.11.0).
 */
export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "whoop.credentials.get" } });

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      whoopClientIdEncrypted: true,
      whoopClientSecretEncrypted: true,
    },
  });

  return apiSuccess({
    hasCredentials:
      !!dbUser?.whoopClientIdEncrypted && !!dbUser?.whoopClientSecretEncrypted,
  });
});

/**
 * Save WHOOP API credentials (encrypted at rest).
 */
export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "whoop.credentials.update" } });

  const { data: body, error: jsonError } = await safeJson(request);
  if (jsonError) return jsonError;

  const result = z.safeParse(whoopCredentialsSchema, body);
  if (!result.success) {
    return apiError("Client ID and Client Secret are required", 422);
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      whoopClientIdEncrypted: encrypt(result.data.clientId),
      whoopClientSecretEncrypted: encrypt(result.data.clientSecret),
    },
  });

  return apiSuccess({ updated: true });
});

/**
 * Delete WHOOP credentials and the active connection.
 */
export const DELETE = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "whoop.credentials.delete" } });

  await prisma.whoopConnection
    .delete({ where: { userId: user.id } })
    .catch(() => {});

  await prisma.user.update({
    where: { id: user.id },
    data: {
      whoopClientIdEncrypted: null,
      whoopClientSecretEncrypted: null,
    },
  });

  return apiSuccess({ deleted: true });
});
