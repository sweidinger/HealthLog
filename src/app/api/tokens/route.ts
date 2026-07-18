/**
 * `/api/tokens` — list and (via `[id]`) revoke a user's API tokens.
 *
 * The generic mint that used to live here (`POST`, minting
 * `["medication:ingest"]`) was removed alongside the fail-closed scope
 * default. That token could never do its advertised job — the external ingest
 * surface gates on the per-medication `medication:<id>:ingest` grant, which
 * this endpoint never issued — while the old fail-open default let it reach
 * every other authenticated route. The working credential is minted by the
 * per-medication API-endpoint toggle
 * (`/api/medications/[id]/api-endpoint`), which issues both grants.
 *
 * Listing and revoking stay so existing tokens remain visible and revocable.
 */
import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess, apiError } from "@/lib/api-response";
import { isApiGloballyEnabled } from "@/lib/app-settings";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "tokens.list" } });

  if (!(await isApiGloballyEnabled())) {
    return apiError("API is globally disabled", 403);
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
