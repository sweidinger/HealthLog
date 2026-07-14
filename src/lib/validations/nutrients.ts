/**
 * Zod schemas — nutrient intake sync (v1.28).
 *
 * Shared between the runtime request parsing
 * (`src/app/api/nutrients/**`) and the OpenAPI route table
 * (`src/lib/openapi/routes/nutrients.ts`) so the wire contract stays
 * single-source. The closed `nutrient` code set comes from the
 * code-side catalog (`src/lib/nutrients/catalog.ts`).
 */
import { z } from "zod/v4";

import { NUTRIENT_CODES } from "@/lib/nutrients/catalog";

export const MAX_NUTRIENT_ENTRIES_PER_BATCH = 500;

export const nutrientCodeEnum = z.enum(NUTRIENT_CODES).meta({
  id: "NutrientCode",
  description:
    "Closed nutrient catalog code — 24 HealthKit Dietary vitamin/mineral types plus water and caffeine. Energy, macros and sodium/potassium are out of scope.",
});

/**
 * One day-total entry. `day` is YYYY-MM-DD in the user's IANA timezone,
 * computed client-side (the `stats:` day-key contract); the server
 * trusts the string after regex + calendar sanity, no re-derivation.
 * `unit` deliberately rides the wire even though the catalog pins it:
 * a µg/mg confusion is a silent 1000× corruption and the one-string
 * echo is the cheapest guard — a mismatch skips the entry.
 */
export const nutrientEntrySchema = z
  .object({
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    nutrient: nutrientCodeEnum,
    unit: z.string().min(1).max(10),
    amount: z.number().finite().min(0),
    externalSourceVersion: z.string().min(1).max(120).optional(),
  })
  .meta({
    id: "NutrientIntakeEntry",
    description:
      "One nutrient day total. day = YYYY-MM-DD in the user's IANA timezone; unit must equal the catalog's canonical unit for the code (mg | ug | ml) or the entry is skipped unit_mismatch.",
  });

export const nutrientBatchSchema = z
  .object({
    entries: z
      .array(nutrientEntrySchema)
      .min(1)
      .max(MAX_NUTRIENT_ENTRIES_PER_BATCH),
  })
  .meta({
    id: "NutrientBatchRequest",
    description:
      "Bulk day-total upsert, max 500 entries. Upsert key is (day, nutrient); a re-post replaces the stored total (last-writer-wins day-total contract).",
  });

/** Per-entry outcome — a re-post is by definition an update, never a duplicate. */
export const nutrientEntryResultSchema = z
  .object({
    index: z.number().int().min(0),
    status: z.enum(["inserted", "updated", "skipped"]),
    reason: z.string().optional(),
  })
  .meta({
    id: "NutrientEntryResult",
    description:
      "Per-entry ingest outcome. skipped reasons: unit_mismatch | value_out_of_range | day_invalid | upsert_failed. Log and drop a skipped entry — do not retry it.",
  });

export const nutrientBatchResponseSchema = z
  .object({
    processed: z.number().int().min(0),
    inserted: z.number().int().min(0),
    updated: z.number().int().min(0),
    skipped: z.array(
      z.object({ index: z.number().int().min(0), reason: z.string() }),
    ),
    entries: z.array(nutrientEntryResultSchema),
  })
  .meta({
    id: "NutrientBatchResponse",
    description:
      "Always 200 when the envelope parses; per-entry failures surface as skipped entries, never a batch failure.",
  });

/** `GET /api/nutrients` query — window size in days, default 14. */
export const nutrientOverviewQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(14),
});

export const nutrientOverviewSchema = z
  .object({
    windowDays: z.number().int().min(1),
    nutrients: z.array(
      z.object({
        nutrient: nutrientCodeEnum,
        unit: z.string(),
        latestDay: z.string(),
        latestAmount: z.number(),
        daysWithData: z.number().int().min(1),
      }),
    ),
  })
  .meta({
    id: "NutrientIntakeOverview",
    description:
      "Per-nutrient window summary in catalog order: latest synced day + total, and the count of days carrying data inside the window. Nutrients without data in the window are omitted.",
  });
