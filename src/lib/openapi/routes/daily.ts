/**
 * OpenAPI route module — the unified daily digest (P3).
 *
 * GET /api/daily/digest returns the `DailyDigest` DTO the Today surface, the
 * daily push, and a future iOS widget all consume. It is a pure read of
 * already-cached data (nightly briefing lift + dashboard-snapshot ingredients
 * + two light deterministic reads) — no provider call, no warm-on-mount. Gated
 * on the `insights` module. Part of the OpenAPI route table; aggregated in
 * `./index.ts`.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";

import { PRIORITY_ITEM_KINDS } from "@/lib/daily/priority-item";
import { dataEnvelope, moduleDisabledResponse, stdResponses } from "./shared";

const priorityItemSchema = z
  .object({
    kind: z.enum([...PRIORITY_ITEM_KINDS]).describe("Closed rail-item kind."),
    title: z.string().describe("Localised headline (resolved server-side)."),
    body: z
      .string()
      .optional()
      .describe("Grounded one-liner, rendered as plain text."),
    status: z
      .enum(["success", "warning", "info", "destructive"])
      .optional()
      .describe("Semantic status wash — meaning, not decoration."),
    actions: z
      .array(
        z.object({
          labelKey: z.string().describe("i18n key, resolved client-side."),
          intent: z.string().describe("Stable action token."),
          href: z.string().optional().describe("Deep-link when navigational."),
        }),
      )
      .max(3)
      .describe("1–3 one-tap actions."),
    moduleKey: z
      .string()
      .optional()
      .describe("Provenance of the gate that admitted the item."),
  })
  .meta({
    id: "DailyPriorityItem",
    description:
      "One 'worth a look' rail item. The single model every daily-value consumer renders through PriorityCard.",
  });

const dailyDigestResponse = z
  .object({
    generatedAt: z.string().describe("ISO-8601 instant the digest was read."),
    phase: z
      .enum(["provisional", "final"])
      .describe("Freshness lifecycle — 'final' once last night's sleep is in."),
    sleepPending: z
      .boolean()
      .describe("Sleep tracked but last night not yet recorded."),
    score: z
      .object({
        value: z.number(),
        band: z.string(),
        delta: z.number().nullable(),
      })
      .nullable()
      .describe("Health score + band + week-over-week delta; null when none."),
    topSignal: z
      .object({
        sourceMetric: z.string(),
        tone: z.enum(["good", "watch", "info"]),
        headline: z.string(),
        nudge: z.string(),
        delta: z.string().nullable(),
      })
      .nullable()
      .describe(
        "Clinical-priority top signal, lifted from the cached briefing.",
      ),
    briefingLead: z
      .string()
      .nullable()
      .describe("First sentence of the cached briefing paragraph."),
    line: z
      .string()
      .describe(
        "Push / lock-screen line: cached-AI lead with a deterministic floor.",
      ),
    worthALook: z
      .array(priorityItemSchema)
      .describe("Bounded 0–3 rail items, never padded."),
  })
  .meta({
    id: "DailyDigest",
    description:
      "The one data spine of the daily-value system — composed from already-cached data, never a fresh AI call. Consumed by the Today surface, the daily push, and a future iOS widget.",
  });

export const dailyPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/daily/digest": {
    get: {
      tags: ["Insights"],
      summary: "The unified daily digest",
      description:
        "Assembles the day's read from already-cached data: the nightly briefing lifted read-only from the insights cache, the dashboard-snapshot health score / meds-today / sleep freshness, plus deterministic integration-status and Vorsorge reads for the 'worth a look' rail. No provider call, no warm-on-mount. Requires the insights module. Cookie or Bearer auth.",
      responses: {
        "200": {
          description: "The daily digest.",
          content: {
            "application/json": {
              schema: dataEnvelope(dailyDigestResponse, "DailyDigestEnvelope"),
            },
          },
        },
        ...moduleDisabledResponse,
        ...stdResponses,
      },
    },
  },
};
