/**
 * `DELETE /api/environment/travel/[id]` — remove a manual travel override.
 *
 * Owner-scoped: the delete `where` carries both the id AND `userId` so one
 * account can never delete another's override. Module-gated. A missing / already
 * deleted row returns 404 rather than leaking existence.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { prisma } from "@/lib/db";

export const DELETE = apiHandler(
  async (_request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { user } = await requireAuth();

    const gate = await requireModuleEnabled(user.id, "environment");
    if (!gate.enabled) return gate.response;

    const { id } = await ctx.params;

    const result = await prisma.environmentTravelLocation.deleteMany({
      where: { id, userId: user.id },
    });
    if (result.count === 0) {
      return apiError("Travel override not found", 404, {
        errorCode: "environment.travel.not_found",
      });
    }

    annotate({
      action: {
        name: "environment.travel.delete",
        entity_type: "environment_travel",
        entity_id: id,
      },
    });

    return apiSuccess({ deleted: true });
  },
);
