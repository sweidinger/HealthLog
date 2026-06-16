/**
 * Illness / condition-journal request/response validation (v1.18.1).
 *
 * Source of truth for the `/api/illness/*` wire contract. The Zod schemas
 * here are reused by the OpenAPI registry so the spec stays single-source.
 * `userId` is NEVER a body field — it is narrowed from the session/Bearer
 * in every route and fed to the Prisma `where`.
 *
 * The journal is a CONDITION journal (any illness/condition kept for
 * oneself), retrospective-only — NEVER a predictor/diagnoser. Day-log
 * dates are `YYYY-MM-DD` strings (the CycleDayLog / MoodEntry tz-anchored
 * convention); instants are ISO-8601 with offset. Free-text notes are
 * encrypted at rest (`noteEncrypted` Bytes column); every other field is
 * queryable plaintext.
 */
import { z } from "zod/v4";
import { isPlausibleEntryInstant } from "@/lib/validations/entry-instant";

/**
 * Plausible-instant bound shared with the measurement / mood / cycle
 * paths: no future instant beyond the 5-min skew, no instant before 1900.
 * Stays a string on the wire (iOS reads it back verbatim).
 */
const boundedInstant = z.iso
  .datetime({ offset: true })
  .refine((s) => isPlausibleEntryInstant(new Date(s)), {
    message: "must be a plausible instant (not future, not pre-1900)",
  });

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date");

/* ── enums (mirror the Prisma enums) ─────────────────────────────── */

export const illnessTypeEnum = z.enum([
  "INFECTION",
  "ALLERGY",
  "INJURY",
  "MENTAL_HEALTH",
  "AUTOIMMUNE",
  "CHRONIC",
  "OTHER",
]);

export const illnessLifecycleEnum = z.enum([
  "ACUTE",
  "CHRONIC_ONGOING",
  "RECURRING",
  "FLARE",
]);

/* ── episode CRUD ─────────────────────────────────────────────────── */

/**
 * Create an episode. `label` is the user-facing name; `note` is encrypted
 * at rest. `parentConditionId` threads a FLARE/RECURRING bout under a
 * parent condition. `onsetAt` defaults to "now" server-side when omitted.
 */
export const illnessEpisodeCreateSchema = z.object({
  label: z.string().min(1).max(120),
  type: illnessTypeEnum,
  lifecycle: illnessLifecycleEnum.optional().default("ACUTE"),
  onsetAt: boundedInstant.optional(),
  resolvedAt: boundedInstant.nullable().optional(),
  parentConditionId: z.string().min(1).max(40).nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
});

export type IllnessEpisodeCreate = z.infer<typeof illnessEpisodeCreateSchema>;

/**
 * Edit an episode — every field optional; an omitted field is left
 * untouched. A `null` `resolvedAt` re-opens a resolved episode.
 */
export const illnessEpisodeUpdateSchema = z
  .object({
    label: z.string().min(1).max(120).optional(),
    type: illnessTypeEnum.optional(),
    lifecycle: illnessLifecycleEnum.optional(),
    onsetAt: boundedInstant.optional(),
    resolvedAt: boundedInstant.nullable().optional(),
    parentConditionId: z.string().min(1).max(40).nullable().optional(),
    note: z.string().max(2000).nullable().optional(),
  })
  .strict();

export type IllnessEpisodeUpdate = z.infer<typeof illnessEpisodeUpdateSchema>;

/** Resolve (mark recovered) — a dedicated PATCH `/resolve` endpoint. */
export const illnessEpisodeResolveSchema = z.object({
  resolvedAt: boundedInstant.optional(),
});

export type IllnessEpisodeResolve = z.infer<
  typeof illnessEpisodeResolveSchema
>;

/** History/list query — newest-first, bounded. */
export const illnessEpisodeListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  includeResolved: z
    .union([z.literal("true"), z.literal("false")])
    .optional(),
});

/* ── day-log capture (one row per day of an episode) ─────────────── */

/**
 * The canonical day-log input for an episode. Upserts on the
 * `(episodeId, date)` key. `note` is encrypted at rest (`noteEncrypted`);
 * `functionalImpact` (0–3) and `feverC` are queryable plaintext. Symptoms
 * carry a 0–3 Jackson/WURSS severity on the link.
 */
export const illnessDayLogInputSchema = z.object({
  date: dateString,
  functionalImpact: z.number().int().min(0).max(3).nullable().optional(),
  feverC: z.number().min(30).max(45).nullable().optional(),
  symptoms: z
    .array(
      z.object({
        key: z.string().min(1).max(80),
        severity: z.number().int().min(0).max(3).optional(),
      }),
    )
    .max(40)
    .optional(),
  note: z.string().max(2000).nullable().optional(),
  loggedAt: boundedInstant.optional(),
});

export type IllnessDayLogInput = z.infer<typeof illnessDayLogInputSchema>;

/** The single-day read query: `GET .../day-logs?date=YYYY-MM-DD`. */
export const illnessDayLogQuerySchema = z.object({ date: dateString });

/* ── P3 retrospective insight window ─────────────────────────────────── */

/**
 * The retrospective-insight window query: `GET /api/illness/insights?
 * windowDays=365`. Bounded 30..1095 days; defaults to a trailing year.
 * Retrospective only — the engine summarises past episodes, never forecasts.
 */
export const illnessInsightsQuerySchema = z.object({
  windowDays: z.coerce.number().int().min(30).max(1095).optional(),
});
