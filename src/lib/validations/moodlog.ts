import { z } from "zod/v4";
import { isPublicUrl } from "@/lib/validations/notifications";

/**
 * @deprecated The standalone moodLog integration is superseded by native
 * mood entries plus structured tags and rated factors — mood is tracked
 * fully inside HealthLog now. These schemas remain only to keep the
 * existing webhook + sync paths functional; the surface is slated for
 * removal in a future major release. The native mood schemas
 * (`createMoodEntrySchema` etc.) below are the supported path.
 */
export const moodLogCredentialsSchema = z.object({
  url: z
    .string()
    .url()
    .max(500)
    // SSRF guard: stored URL must point at a public host. The sync
    // worker fetches from this URL with the user's apiKey in the
    // Authorization header, so a stored RFC1918 / link-local target
    // would let any user pull cloud-metadata or local-network data
    // back through their account.
    .refine((u) => isPublicUrl(u), {
      message: "URL must point at a public host (no RFC1918 / link-local)",
    }),
  apiKey: z.string().min(1).max(200),
});

export const moodLogWebhookPayloadSchema = z.object({
  event: z.enum(["mood.created", "mood.updated", "mood.deleted"]),
  timestamp: z.string().datetime(),
  entry: z.object({
    // v1.12.1 — optional source-stable entry id. When present, the
    // webhook dedups on `(userId, source, externalId)` so a re-emit with
    // a re-rounded / re-zoned `time` is idempotent instead of minting a
    // second row. Absent → the legacy `(userId, date, moodLoggedAt)`
    // path. Bounded so a malformed upstream id can't bloat the column.
    id: z.string().min(1).max(120).optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    time: z.string().datetime(),
    mood: z.enum(["SUPER_GUT", "GUT", "OKAY", "SCHLECHT", "LAUSIG"]),
    score: z.number().int().min(1).max(5),
    tags: z.array(z.string()).max(50).optional(),
    loggedVia: z.enum(["WEB", "TELEGRAM", "DAYLIO"]).optional(),
  }),
});

export const moodLogSyncResponseSchema = z.object({
  version: z.string(),
  entries: z.array(
    z.object({
      // v1.12.1 — optional source-stable id, mirrors the webhook entry.
      // Carried into `externalId` for idempotent re-import.
      id: z.string().min(1).max(120).optional(),
      date: z.string(),
      time: z.string(),
      mood: z.string(),
      score: z.number(),
      tags: z.array(z.string()).optional(),
      loggedVia: z.string().optional(),
    }),
  ),
});

export type MoodLogCredentials = z.infer<typeof moodLogCredentialsSchema>;
export type MoodLogWebhookPayload = z.infer<typeof moodLogWebhookPayloadSchema>;
export type MoodLogSyncResponse = z.infer<typeof moodLogSyncResponseSchema>;

// --- CRUD schemas for mood entries ---

export const moodLevelEnum = z.enum([
  "SUPER_GUT",
  "GUT",
  "OKAY",
  "SCHLECHT",
  "LAUSIG",
]);

export const moodSourceEnum = z.enum([
  "MANUAL",
  "MOODLOG",
  "WEB",
  "TELEGRAM",
  "DAYLIO",
]);

const MOOD_SCORE_MAP: Record<string, number> = {
  SUPER_GUT: 5,
  GUT: 4,
  OKAY: 3,
  SCHLECHT: 2,
  LAUSIG: 1,
};

export function getScoreForMood(mood: string): number {
  return MOOD_SCORE_MAP[mood] ?? 3;
}

// v1.8.5 — structured-tag keys picked from the catalog (`mood_tags.key`).
// Additive alongside the flat free-text `tags`: an entry can carry both.
// Bounded so a single create can't fan out an unbounded link set.
const structuredTagKeys = z.array(z.string().max(60)).max(30);

// v1.12.0 — rated mood factors. A factor is a catalog `MoodTag` of
// `kind = 'RATED'`; the user scores it per entry, and the score persists
// on `MoodEntryTagLink.rating`. The wire shape is a parallel array to
// `tagKeys` (binary), keeping the binary contract byte-identical and the
// iOS Codable model simple (`[{ key, rating }]`).
//
// The Zod `rating` bound here is the OUTER envelope (1..5 covers every
// seeded factor's scale). The REAL gate is per-tag: after resolving each
// key to its `MoodTag`, the server rejects a rating outside the tag's own
// `scaleMin..scaleMax` (e.g. 1..2 for `factor_conflict`). See
// `resolveRatedFactors` in `src/lib/mood/tag-links.ts`.
const ratedFactor = z.object({
  key: z.string().max(60),
  rating: z.number().int().min(1).max(5),
});
const ratedFactors = z.array(ratedFactor).max(30);

export const createMoodEntrySchema = z.object({
  mood: moodLevelEnum,
  tags: z.array(z.string().max(50)).max(20).optional(),
  // v1.8.5 — structured-tag keys from the taxonomy. Server resolves each
  // key to a `MoodTag` row and writes the `MoodEntryTagLink` join;
  // unknown keys are dropped silently (the catalog is the source of
  // truth, a stale client can't mint a tag).
  tagKeys: structuredTagKeys.optional(),
  // v1.12.0 — rated factors scored 1..5 (or the factor's own scale).
  // Parallel to the binary `tagKeys`; persisted on
  // `MoodEntryTagLink.rating`. Out-of-scale or non-RATED keys are
  // rejected (422) / dropped server-side per the catalog.
  ratedFactors: ratedFactors.optional(),
  // v1.4.30 H-5 — first-class free-text note. Replaces the
  // `tags: ["note:<text>"]` workaround. Capped at 500 chars so the
  // Coach evidence shelf renders cleanly without truncating chips.
  note: z.string().max(500).optional(),
  moodLoggedAt: z.iso.datetime({ offset: true }).transform((s) => new Date(s)),
  source: moodSourceEnum.optional().default("MANUAL"),
  // v1.12.1 — optional source-stable id (e.g. an iOS SwiftData row UUID).
  // When present, the create upserts on `(userId, source, externalId)`
  // so a re-post with the same id updates the existing row in place
  // instead of either 409-ing or minting a duplicate — the idempotent
  // re-import iOS drives over Bearer. NULL keeps the legacy
  // `(userId, date, moodLoggedAt)` behaviour. Bound matches the bulk
  // `externalId` so one path can't accept an id the other rejects.
  externalId: z.string().min(1).max(120).optional(),
});

export const updateMoodEntrySchema = z.object({
  mood: moodLevelEnum.optional(),
  tags: z.array(z.string().max(50)).max(20).nullable().optional(),
  // v1.8.5 — full replacement of the structured-tag set when present.
  // `null` clears every link; omit to leave links untouched.
  tagKeys: structuredTagKeys.nullable().optional(),
  // v1.12.0 — full replacement of the rated-factor set when present.
  // `null` clears every rated link; omit to leave them untouched.
  ratedFactors: ratedFactors.nullable().optional(),
  note: z.string().max(500).nullable().optional(),
  moodLoggedAt: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .optional(),
});

export const listMoodEntriesSchema = z.object({
  mood: moodLevelEnum.optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
  sortBy: z
    .enum(["date", "mood", "score", "moodLoggedAt", "source"])
    .optional()
    .default("moodLoggedAt"),
  sortDir: z.enum(["asc", "desc"]).optional().default("desc"),
});

export type CreateMoodEntryInput = z.infer<typeof createMoodEntrySchema>;
export type UpdateMoodEntryInput = z.infer<typeof updateMoodEntrySchema>;
export type ListMoodEntriesInput = z.infer<typeof listMoodEntriesSchema>;
