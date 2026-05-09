import { NextRequest } from "next/server";
import { z } from "zod/v4";

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess, apiError, safeJson } from "@/lib/api-response";

/**
 * v1.4.15 Phase B5 — onboarding tour completion endpoint.
 *
 * Two operations on a single resource:
 *
 *   POST { completed: true,  outcome: "completed" | "skipped" }
 *     → flips `users.onboarding_tour_completed` to true. Auto-fires
 *       when the user reaches the end of the spotlight tour OR
 *       explicitly dismisses it.
 *
 *   POST { completed: false }
 *     → resets the flag so the user can replay the tour from
 *       Settings → Account → "Restart onboarding tour".
 *
 * The `outcome` field is informational — it lands in the structured
 * Wide Event annotation so analytics can tell completion from
 * dismiss without writing two columns. Same DB write either way.
 */

const tourBodySchema = z.object({
  completed: z.boolean(),
  outcome: z.enum(["completed", "skipped"]).optional(),
});

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const { data: body, error: jsonError } = await safeJson(request);
  if (jsonError) return jsonError;

  const parsed = z.safeParse(tourBodySchema, body);
  if (!parsed.success) {
    return apiError("Invalid input", 422);
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { onboardingTourCompleted: parsed.data.completed },
  });

  annotate({
    action: { name: "onboarding.tour.update" },
    meta: {
      completed: parsed.data.completed,
      outcome: parsed.data.outcome ?? null,
    },
  });

  return apiSuccess({ onboardingTourCompleted: parsed.data.completed });
});
