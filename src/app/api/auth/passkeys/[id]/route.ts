import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";

export const DELETE = apiHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { user } = await requireAuth();

  const { id } = await params;

  const passkey = await prisma.passkey.findUnique({
    where: { id },
  });

  if (!passkey || passkey.userId !== user.id) {
    return apiError("Passkey nicht gefunden", 404);
  }

  // Check: at least 1 auth method must remain
  const passkeyCount = await prisma.passkey.count({
    where: { userId: user.id },
  });
  const hasPassword = !!user.passwordHash;

  if (passkeyCount <= 1 && !hasPassword) {
    return apiError(
      "Kann nicht gelöscht werden — es muss mindestens eine Anmeldemethode bestehen bleiben",
      400,
    );
  }

  await prisma.passkey.delete({ where: { id } });

  await auditLog("auth.passkey.delete", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { passkeyId: id, passkeyName: passkey.name },
  });

  annotate({ action: { name: "auth.passkey.delete" } });

  return apiSuccess({ success: true });
});
