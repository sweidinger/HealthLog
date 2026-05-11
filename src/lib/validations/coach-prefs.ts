/**
 * v1.4.23 H4 — per-user Coach prompt-tuning preferences.
 *
 * Persisted as a Json blob on `User.coachPrefsJson`. Null = legacy
 * defaults (tone="warm", verbosity="default", no metrics excluded,
 * evidence disclosure closed by default). The Coach prompt builder +
 * snapshot builder both read this shape — the snapshot must filter on
 * `excludeMetrics` BEFORE landing in the system prompt so the model
 * never sees data the user opted out of.
 */
import { z } from "zod/v4";

/**
 * Tone presets the Coach system-prompt prefix toggles between. v1.4.22
 * landed `warm` as the default; `neutral` strips the warmth language
 * for users who prefer a clinical-adjacent style; `concise` caps
 * verbosity and skips the optional motivational-interviewing micro-
 * moves entirely.
 */
export const coachToneEnum = z.enum(["warm", "neutral", "concise"]);
export type CoachTone = z.infer<typeof coachToneEnum>;

/**
 * Verbosity presets. Maps onto the prompt's "60-180 words" guidance:
 * `brief` ≈ 30-90 words, `default` keeps the v1.4.22 range, `detailed`
 * lifts the cap to 250 words. The `concise` tone overrides verbosity
 * down to `brief` regardless of the verbosity selection — same
 * intuition as concise == short, the picker just keeps the controls
 * orthogonal in the UI for clarity.
 */
export const coachVerbosityEnum = z.enum(["brief", "default", "detailed"]);
export type CoachVerbosity = z.infer<typeof coachVerbosityEnum>;

/**
 * Metric scopes the user can exclude from every Coach turn. Matches
 * `CoachScopeSource` (`src/lib/ai/coach/types.ts`) so the snapshot
 * builder can filter without a translation step. Apple Health-only
 * metrics (hrv / sleep / resting_hr / steps) are listed alongside the
 * core five so iOS users have a single surface to manage their privacy
 * preferences.
 */
export const coachExcludeMetricEnum = z.enum([
  "bp",
  "weight",
  "pulse",
  "mood",
  "compliance",
  "hrv",
  "sleep",
  "resting_hr",
  "steps",
]);
export type CoachExcludeMetric = z.infer<typeof coachExcludeMetricEnum>;

/**
 * Full preferences shape. Defaults are inlined into the schema so a
 * `safeParse({})` call returns the legacy v1.4.22 defaults — saves a
 * sprinkle of `?? defaultX` calls at the call sites.
 */
export const coachPrefsSchema = z.object({
  tone: coachToneEnum.default("warm"),
  verbosity: coachVerbosityEnum.default("default"),
  excludeMetrics: z.array(coachExcludeMetricEnum).max(9).default([]),
  showEvidenceByDefault: z.boolean().default(false),
});

export type CoachPrefs = z.infer<typeof coachPrefsSchema>;

/**
 * Default preferences applied when the user has never opened the
 * settings cog. Equivalent to `coachPrefsSchema.parse({})` but
 * returned as a plain object so call sites can compare references
 * (e.g., short-circuit a snapshot rebuild when prefs match defaults).
 */
export const DEFAULT_COACH_PREFS: CoachPrefs = {
  tone: "warm",
  verbosity: "default",
  excludeMetrics: [],
  showEvidenceByDefault: false,
};

/**
 * Parse a row's `coachPrefsJson` Json blob into a typed `CoachPrefs`,
 * falling back to defaults when the row is null OR the persisted shape
 * has drifted (a forward-compat field rename, an admin-side hand-edit,
 * etc.). Keeps the call sites at `src/lib/ai/coach/snapshot.ts` and
 * `src/lib/ai/coach/system-prompt.ts` free of the null/parse plumbing.
 */
export function parseCoachPrefs(raw: unknown): CoachPrefs {
  if (raw == null) return DEFAULT_COACH_PREFS;
  const parsed = coachPrefsSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_COACH_PREFS;
}
