/**
 * OpenAPI route module — hydration daily-goal surface (v1.25).
 *
 * `GET /api/hydration` reads today's summed water intake vs the user's goal;
 * `PATCH /api/hydration` sets the per-user daily goal. Logging rides the
 * measurements create path (POST /api/measurements, type WATER_INTAKE), so it
 * is documented there, not here.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";

import { dataEnvelope, stdResponses } from "./shared";

const hydrationEntry = z.object({
  id: z.string(),
  value: z.number().describe("Logged amount in millilitres."),
  measuredAt: z.string().describe("ISO-8601 instant the entry was logged."),
});

const hydrationTodayResponse = z
  .object({
    date: z.string().describe("ISO-8601 start of the user's local day."),
    totalMl: z.number().describe("Today's summed intake in ml."),
    goalMl: z.number().describe("Effective daily goal in ml."),
    percent: z.number().describe("Progress toward the goal, capped at 100."),
    rawPercent: z.number().describe("Uncapped progress; can exceed 100."),
    met: z.boolean().describe("Whether the day's total reached the goal."),
    remainingMl: z.number().describe("Remaining ml to the goal (0 once met)."),
    entries: z.array(hydrationEntry),
  })
  .meta({
    id: "HydrationToday",
    description: "Today's water-intake total vs the user's daily goal.",
  });

const hydrationGoalRequest = z
  .object({
    goalMl: z
      .number()
      .int()
      .min(250)
      .max(8000)
      .describe("Daily hydration goal in millilitres."),
  })
  .meta({
    id: "HydrationGoalRequest",
    description: "Set the per-user daily hydration goal (ml).",
  });

const hydrationGoalResponse = z
  .object({ goalMl: z.number() })
  .meta({ id: "HydrationGoalResponse" });

export const hydrationPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/hydration": {
    get: {
      tags: ["Hydration"],
      summary: "Today's hydration total vs goal",
      description:
        "Sums the calling user's WATER_INTAKE measurements for the current local day and compares them against the per-user goal (default 2000 ml).",
      responses: {
        "200": {
          description: "Today's hydration summary.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                hydrationTodayResponse,
                "HydrationTodayEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Hydration"],
      summary: "Set the daily hydration goal",
      description: "Updates the per-user daily hydration goal in millilitres.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: hydrationGoalRequest } },
      },
      responses: {
        "200": {
          description: "Goal updated.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                hydrationGoalResponse,
                "HydrationGoalEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
};
