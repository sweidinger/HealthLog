import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess, apiError, safeJson } from "@/lib/api-response";
import { hashToken } from "@/lib/auth/hmac";
import { isApiGloballyEnabled } from "@/lib/app-settings";
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { z } from "zod/v4";

const createTokenSchema = z.object({
  name: z.string().min(1, "Name erforderlich").max(100),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "tokens.list" } });

  if (!(await isApiGloballyEnabled())) {
    return apiError("API ist global deaktiviert", 403);
  }

  const tokens = await prisma.apiToken.findMany({
    where: { userId: user.id },
    select: {
      id: true,
      name: true,
      permissions: true,
      lastUsedAt: true,
      expiresAt: true,
      createdAt: true,
      revoked: true,
    },
    orderBy: { createdAt: "desc" },
  });

  return apiSuccess(tokens);
});

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "tokens.create" } });

  if (!(await isApiGloballyEnabled())) {
    return apiError("API ist global deaktiviert", 403);
  }

  const { data: body, error: jsonError } = await safeJson(request);

  if (jsonError) return jsonError;
  const parsed = createTokenSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0].message, 422);
  }

  const { name, expiresInDays } = parsed.data;

  // Generate a random token
  const rawToken = `hlk_${randomBytes(32).toString("hex")}`;
  const tokenHashValue = hashToken(rawToken);

  await prisma.apiToken.create({
    data: {
      userId: user.id,
      name,
      tokenHash: tokenHashValue,
      permissions: ["medication:ingest"],
      expiresAt: expiresInDays
        ? new Date(Date.now() + expiresInDays * 86400000)
        : null,
    },
  });

  // Return the raw token ONCE — it can never be retrieved again
  return apiSuccess({ token: rawToken, name }, 201);
});
