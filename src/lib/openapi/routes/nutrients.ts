/**
 * OpenAPI route table — nutrient intake sync (v1.28).
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`. Request
 * and response bodies come from `src/lib/validations/nutrients.ts` so
 * the wire contract stays single-source. The batch description embeds
 * the code ↔ HealthKit-identifier ↔ unit table generated from the
 * code-side catalog — the iOS client reads the pinned HK query unit
 * per type from here (this is the documented home of that table).
 */
import type { ZodOpenApiObject } from "zod-openapi";

import { NUTRIENT_DEFINITIONS } from "@/lib/nutrients/catalog";
import {
  nutrientBatchSchema,
  nutrientBatchResponseSchema,
  nutrientOverviewQuerySchema,
  nutrientOverviewSchema,
} from "@/lib/validations/nutrients";
import { dataEnvelope, errorEnvelope, stdResponses } from "./shared";

const moduleDisabled = {
  "403": {
    description:
      "The opt-in `nutrients` module is off for this account (errorCode `module.disabled`). Stop syncing and do not retry; offer the enable-in-settings hint. Only run the HealthKit read-authorization flow while the module is on.",
    content: { "application/json": { schema: errorEnvelope } },
  },
} as const;

/**
 * The catalog table, rendered into the endpoint description so the
 * OpenAPI file is the one authoritative home of the code ↔ HK ↔ unit
 * contract (µg is `ug` on the wire; water is mL; never IU).
 */
const catalogTable = NUTRIENT_DEFINITIONS.map(
  (d) => `| ${d.code} | ${d.hkIdentifier} | ${d.unit} |`,
).join("\n");

export const nutrientPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/nutrients/batch": {
    post: {
      tags: ["Nutrients"],
      summary: "Ingest micronutrient day totals (v1.28)",
      description:
        "Bulk upsert of supplement-style daily totals synced from HealthKit — vitamins, minerals, water, caffeine. Day totals only: compute HKStatisticsCollectionQuery cumulative sums day-anchored in the user's current IANA timezone; `day` is yyyy-MM-dd in that timezone (the same rule as the `stats:` day keys). Never post raw samples. Upsert key is (day, nutrient): a re-post replaces the stored total and reports `updated`. Post the current + previous local day per sync; backfill 30 days on first enable. Max 500 entries; Idempotency-Key supported; rate limit 60/min. Per-entry skips (`unit_mismatch` | `value_out_of_range` | `day_invalid`) are terminal — log and drop, do not retry the entry. Behind the opt-in `nutrients` module (403 `module.disabled` when off). Query HealthKit with exactly the listed unit per code (`ug` = microgram; do not convert to IU):\n\n| code | HealthKit identifier | unit |\n| --- | --- | --- |\n" +
        catalogTable,
      requestBody: {
        required: true,
        content: { "application/json": { schema: nutrientBatchSchema } },
      },
      responses: {
        "200": {
          description:
            "Batch processed; per-entry statuses inserted | updated | skipped.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                nutrientBatchResponseSchema,
                "NutrientBatchEnvelope",
              ),
            },
          },
        },
        ...moduleDisabled,
        ...stdResponses,
      },
    },
  },
  "/api/nutrients": {
    get: {
      tags: ["Nutrients"],
      summary: "Synced-nutrient window summary (v1.28)",
      description:
        "Per-nutrient summary of the last `days` days (default 14): latest synced day + total and the days-with-data count, in catalog order. Read-only; feeds the settings card. Behind the opt-in `nutrients` module.",
      requestParams: { query: nutrientOverviewQuerySchema },
      responses: {
        "200": {
          description: "The window summary.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                nutrientOverviewSchema,
                "NutrientOverviewEnvelope",
              ),
            },
          },
        },
        ...moduleDisabled,
        ...stdResponses,
      },
    },
  },
};
