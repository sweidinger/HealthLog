import { prisma } from "@/lib/db";
import { profileSchema } from "@/lib/validations/auth";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp, safeJson } from "@/lib/api-response";
import { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";

export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const { data: body, error: jsonError } = await safeJson(request);

  if (jsonError) return jsonError;
  const parsed = profileSchema.safeParse(body);

  if (!parsed.success) {
    return apiError(parsed.error.issues[0].message, 422);
  }

  const data = parsed.data;
  const normalizedEmail = data.email ? data.email.trim().toLowerCase() : null;

  if (data.email !== undefined && normalizedEmail) {
    const existingUser = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true },
    });

    if (existingUser && existingUser.id !== user.id) {
      return apiError("Email already in use", 409);
    }
  }

  const updatedUser = await prisma.user.update({
    where: { id: user.id },
    data: {
      ...(data.email !== undefined ? { email: normalizedEmail } : {}),
      heightCm: data.heightCm ?? null,
      dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : null,
      ...(data.gender !== undefined ? { gender: data.gender } : {}),
    },
  });

  await auditLog("profile.update", {
    userId: updatedUser.id,
    ipAddress: getClientIp(request),
  });

  annotate({ action: { name: "auth.profile.update" } });

  return apiSuccess({
    id: updatedUser.id,
    username: updatedUser.username,
    email: updatedUser.email,
    role: updatedUser.role,
    heightCm: updatedUser.heightCm,
    dateOfBirth: updatedUser.dateOfBirth,
    gender: updatedUser.gender,
    timezone: updatedUser.timezone,
  });
});
