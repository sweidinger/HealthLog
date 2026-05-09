import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess, apiError } from "@/lib/api-response";
import { isApiGloballyEnabled } from "@/lib/app-settings";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * Revoke an API token.
 */
export const DELETE = apiHandler(
  async (_request: Request, { params }: RouteParams) => {
    const { user } = await requireAuth();
    annotate({ action: { name: "tokens.revoke" } });

    if (!(await isApiGloballyEnabled())) {
      return apiError("API is globally disabled", 403);
    }

    const { id } = await params;
    const token = await prisma.apiToken.findUnique({ where: { id } });

    if (!token || token.userId !== user.id) {
      return apiError("Token not found", 404);
    }

    await prisma.apiToken.update({
      where: { id },
      data: { revoked: true },
    });

    return apiSuccess({ revoked: true });
  },
);
