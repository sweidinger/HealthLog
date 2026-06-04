/**
 * /api/share-links — owner clinician-share-link lifecycle (Epic C, C4).
 *
 *   POST  → create a link. Mints an `hls_<48 hex>` token (192-bit), stores
 *           ONLY its HMAC hash, returns the raw token EXACTLY ONCE. Every
 *           scope column is frozen write-once at creation.
 *   GET   → list the caller's own links (never the raw token — it is
 *           unrecoverable after the create response).
 *
 * Auth: cookie session OR Bearer (`requireAuth`). `userId` is always narrowed
 * from the auth context; there is no `userId` body field. Rate-limited.
 * This is the OWNER lifecycle only — the public resolver / view (C3/C5) is a
 * separate surface.
 */
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { hashToken } from "@/lib/auth/hmac";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/db";
import { createShareLinkSchema } from "@/lib/validations/clinician-share-link";
import type { Prisma } from "@/generated/prisma/client";

/** Project a stored row to the safe owner-facing shape (never the token). */
function toSummary(row: {
  id: string;
  label: string;
  rangeStart: Date;
  rangeEnd: Date | null;
  resourceTypes: string[];
  allowFhirApi: boolean;
  expiresAt: Date;
  createdAt: Date;
  revokedAt: Date | null;
  lastAccessAt: Date | null;
  accessCount: number;
}) {
  return {
    id: row.id,
    label: row.label,
    rangeStart: row.rangeStart.toISOString(),
    rangeEnd: row.rangeEnd ? row.rangeEnd.toISOString() : null,
    resourceTypes: row.resourceTypes,
    allowFhirApi: row.allowFhirApi,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    lastAccessAt: row.lastAccessAt ? row.lastAccessAt.toISOString() : null,
    accessCount: row.accessCount,
    // Status the UI can render without re-deriving expiry/revocation.
    active:
      row.revokedAt === null && row.expiresAt.getTime() > Date.now(),
  };
}

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "share-link.create" } });

  const rl = await checkRateLimit(
    `share-link:${user.id}`,
    20,
    60 * 60 * 1000,
  );
  if (!rl.allowed) {
    return apiError("Maximum 20 share-link operations per hour", 429);
  }

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 16 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = createShareLinkSchema.safeParse(body);
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error);
  }
  const input = parsed.data;

  // Mint the 192-bit raw token, store only its HMAC hash.
  const rawToken = `hls_${randomBytes(24).toString("hex")}`;
  const tokenHash = hashToken(rawToken);

  // Field-by-field build — no mass assignment. Scope columns are written
  // exactly once here and never updated.
  const created = await prisma.clinicianShareLink.create({
    data: {
      userId: user.id,
      tokenHash,
      label: input.label,
      rangeStart: new Date(input.rangeStart),
      rangeEnd: input.rangeEnd ? new Date(input.rangeEnd) : null,
      sectionsJson: (input.sections ?? {}) as Prisma.InputJsonValue,
      resourceTypes: input.resourceTypes ?? [],
      allowFhirApi: input.allowFhirApi ?? false,
      expiresAt: new Date(input.expiresAt),
    },
    select: {
      id: true,
      label: true,
      rangeStart: true,
      rangeEnd: true,
      resourceTypes: true,
      allowFhirApi: true,
      expiresAt: true,
      createdAt: true,
      revokedAt: true,
      lastAccessAt: true,
      accessCount: true,
    },
  });

  await auditLog("share-link.create", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      shareLinkId: created.id,
      resourceTypes: created.resourceTypes,
      allowFhirApi: created.allowFhirApi,
      expiresAt: created.expiresAt.toISOString(),
    },
  });

  // The raw token is returned exactly once; it is unrecoverable thereafter.
  return apiSuccess({ ...toSummary(created), token: rawToken }, 201);
});

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "share-link.list" } });

  const rows = await prisma.clinicianShareLink.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      label: true,
      rangeStart: true,
      rangeEnd: true,
      resourceTypes: true,
      allowFhirApi: true,
      expiresAt: true,
      createdAt: true,
      revokedAt: true,
      lastAccessAt: true,
      accessCount: true,
    },
  });

  return apiSuccess({ shareLinks: rows.map(toSummary) });
});
