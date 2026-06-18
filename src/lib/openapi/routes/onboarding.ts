/**
 * OpenAPI route table — onboarding module tour.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 * The request schema comes from `src/lib/onboarding/tour-progress.ts`
 * so the wire contract stays single-source with the runtime parser.
 *
 * v1.18.6 — the resumable module-tour contract the iOS client mirrors:
 * a fire-and-forget progress checkpoint plus the coarse completion
 * flip. The resume point also rides `GET /api/auth/me` as
 * `onboardingTourProgress`.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";

import { tourProgressSchema } from "@/lib/onboarding/tour-progress";
import { dataEnvelope, stdResponses } from "./shared";

const tourProgressResource = tourProgressSchema.meta({
  id: "TourProgress",
  description:
    "Resumable module-tour progress point. `lastStopId` seeds the resume index; `status` is the running/terminal state.",
});

const tourUpdateRequest = z
  .object({
    completed: z
      .boolean()
      .optional()
      .describe(
        "Flip the coarse completion flag. `false` is a replay reset and clears the stored progress point.",
      ),
    outcome: z
      .enum(["completed", "skipped"])
      .optional()
      .describe("Informational — distinguishes reaching the end from a skip."),
    progress: tourProgressResource
      .optional()
      .describe("Mid-tour resume checkpoint. May arrive alone or with `completed`."),
  })
  .meta({
    id: "TourUpdateRequest",
    description:
      "Update the module-tour state. Provide `completed` and/or `progress`.",
  });

const tourUpdateResponse = z
  .object({
    onboardingTourCompleted: z.boolean(),
    progress: tourProgressResource.nullable(),
  })
  .meta({
    id: "TourUpdateResponse",
    description: "The persisted completion flag and resume point after the write.",
  });

export const onboardingPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/onboarding/tour": {
    post: {
      tags: ["Onboarding"],
      summary: "Update module-tour completion + resume point",
      description:
        "Persists the module-tour state. The client posts a fire-and-forget `progress` checkpoint on each step so a reload resumes at the right module, and a terminal `completed:true` with `outcome` when the tour ends. `completed:false` is a replay reset that also clears the resume point.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: tourUpdateRequest } },
      },
      responses: {
        "200": {
          description: "Tour state updated.",
          content: {
            "application/json": {
              schema: dataEnvelope(tourUpdateResponse, "TourUpdateEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
};
