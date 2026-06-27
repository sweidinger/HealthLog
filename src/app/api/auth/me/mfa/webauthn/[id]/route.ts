/**
 * PATCH  /api/auth/me/mfa/webauthn/[id]  — rename a registered security key.
 * DELETE /api/auth/me/mfa/webauthn/[id]  — remove one (step-up gated).
 *
 * Rename is cookie-authenticated (non-destructive). Removal is a sensitive
 * action: it is gated on a fresh second-factor step-up (`requireFreshMfa`,
 * cookie-only — a Bearer token can never satisfy it).
 */
import { NextRequest } from "next/server";
import {
  apiHandler,
  requireCookieAuth,
  requireFreshMfa,
  MFA_STEP_UP_MAX_AGE_SECONDS,
} from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { mfaWebauthnRenameSchema } from "@/lib/validations/mfa";

export const dynamic = "force-dynamic";

export const PATCH = apiHandler(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) => {
    const { user } = await requireCookieAuth();
    const { id } = await params;

    const { data: body, error: jsonError } = await safeJson(request, {
      maxBytes: 4 * 1024,
    });
    if (jsonError) return jsonError;

    const parsed = mfaWebauthnRenameSchema.safeParse(body);
    if (!parsed.success) {
      return apiError("Invalid request", 422);
    }

    const existing = await prisma.webauthnMfaCredential.findUnique({
      where: { id },
      select: { userId: true },
    });
    if (!existing || existing.userId !== user.id) {
      return apiError("Security key not found", 404);
    }

    const updated = await prisma.webauthnMfaCredential.update({
      where: { id },
      data: { name: parsed.data.name },
      select: { id: true, name: true, createdAt: true, lastUsedAt: true },
    });

    annotate({ action: { name: "auth.mfa.webauthn.rename" } });
    return apiSuccess(updated);
  },
);

export const DELETE = apiHandler(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) => {
    // Step-up gate first — throws StepUpRequiredError (401 + errorCode) if the
    // session is not freshly second-factor-verified.
    const { user } = await requireFreshMfa(MFA_STEP_UP_MAX_AGE_SECONDS);
    const { id } = await params;

    const existing = await prisma.webauthnMfaCredential.findUnique({
      where: { id },
      select: { userId: true, name: true },
    });
    if (!existing || existing.userId !== user.id) {
      return apiError("Security key not found", 404);
    }

    await prisma.webauthnMfaCredential.delete({ where: { id } });

    await auditLog("auth.mfa.webauthn.remove", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { credentialId: id, name: existing.name },
    });
    annotate({ action: { name: "auth.mfa.webauthn.remove" } });

    return apiSuccess({ success: true });
  },
);
