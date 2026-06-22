/**
 * v1.20.0 (F1) — Coach retrieval tool catalogue.
 *
 * Replaces snapshot-stuffing with on-demand retrieval: the model is handed a
 * tiny DATA INVENTORY in the base context and pulls only the domains it needs
 * via these tools. Each tool is a THIN, READ-ONLY wrapper over the existing
 * server-authoritative snapshot builder (`buildCoachSnapshot`) — same numbers,
 * same module/cycle gates, same I/O. No tool ever accepts `userId` (it is
 * narrowed from the session in the executor), and every tool is read-only, so
 * there is no new mutation or egress surface.
 *
 * Six tools ship in v1.20.0 (the research's recommended slice):
 *   1. get_metric_series         — BP / weight / pulse + the ~38 additive series
 *   2. get_glucose_panel         — per-context daily means + the 30-day clinical panel
 *   3. get_sleep                 — per-night sleep + sleep-rhythm (debt + chronotype)
 *   4. get_medication_compliance — dose-weighted compliance + GLP-1
 *   5. get_labs                  — latest reading per biomarker (12 months)
 *   6. get_illness_recovery      — restMode + active/resolved illnesses + recovery composites
 *
 * cycle / correlation / workouts are deferred to a later release.
 */
import { z } from "zod/v4";

import type { AiToolDef } from "@/lib/ai/types";
import {
  coachScopeSourceSchema,
  coachScopeWindowSchema,
} from "@/lib/ai/coach/types";

/** The closed set of tool names F1 ships. */
export const COACH_TOOL_NAMES = [
  "get_metric_series",
  "get_glucose_panel",
  "get_sleep",
  "get_medication_compliance",
  "get_labs",
  "get_illness_recovery",
] as const;

export type CoachToolName = (typeof COACH_TOOL_NAMES)[number];

export function isCoachToolName(name: string): name is CoachToolName {
  return (COACH_TOOL_NAMES as readonly string[]).includes(name);
}

// ── Per-tool argument schemas ────────────────────────────────────────
// Closed enums + optional windows only — no free-text, no host, no id. The
// executor `safeParse`s the model's raw JSON arguments against these before it
// touches the snapshot builder, so a malformed / adversarial argument blob can
// never widen scope or reach an un-validated read.

export const getMetricSeriesArgsSchema = z
  .object({
    metric: coachScopeSourceSchema,
    window: coachScopeWindowSchema.optional(),
  })
  .strict();

export const getGlucosePanelArgsSchema = z
  .object({
    window: coachScopeWindowSchema.optional(),
  })
  .strict();

export const getSleepArgsSchema = z
  .object({
    window: coachScopeWindowSchema.optional(),
  })
  .strict();

export const getMedicationComplianceArgsSchema = z
  .object({
    window: coachScopeWindowSchema.optional(),
  })
  .strict();

export const getLabsArgsSchema = z
  .object({
    /** Optional single-analyte filter (free-text biomarker name). */
    analyte: z.string().min(1).max(80).optional(),
  })
  .strict();

export const getIllnessRecoveryArgsSchema = z.object({}).strict();

/**
 * JSON-Schema parameter shapes handed to the provider. Kept hand-written
 * (rather than generated from Zod) so the wire description the model reads is
 * compact and stable — the byte-stable tool block keeps the cached prefix
 * intact across turns.
 */
const WINDOW_ENUM = [
  "last7days",
  "last30days",
  "last90days",
  "lastYear",
  "allTime",
];

/**
 * The tool definitions offered to the model. Descriptions are deliberately
 * terse and brand-free; they tell the model WHEN to reach for each tool and
 * that an absent domain returns `{ present: false }` rather than an error.
 */
export const COACH_TOOL_DEFS: AiToolDef[] = [
  {
    name: "get_metric_series",
    description:
      "Fetch the user's own time series for ONE metric: blood pressure (bp), weight, pulse, or any synced series (hrv, resting_hr, steps, sleep duration, body composition, gait, audio exposure, vo2_max, …). Returns an aggregate plus a recent-daily and weekly timeline. Call once per metric you need; call several in parallel for a multi-metric question. Returns { present: false } when the user has no data for that metric.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["metric"],
      properties: {
        metric: {
          type: "string",
          enum: coachScopeSourceSchema.options,
          description: "The metric to fetch.",
        },
        window: {
          type: "string",
          enum: WINDOW_ENUM,
          description: "Analysis window. Defaults to the user's scope window.",
        },
      },
    },
  },
  {
    name: "get_glucose_panel",
    description:
      "Fetch the user's glucose data: per-context daily means plus the trailing-30-day clinical panel (time-in-range, GMI, CV%, estimated A1c). Returns { present: false } when the user logs no glucose.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {
        window: {
          type: "string",
          enum: WINDOW_ENUM,
          description:
            "Window for the per-context means. The clinical panel is always the fixed trailing 30 days.",
        },
      },
    },
  },
  {
    name: "get_sleep",
    description:
      "Fetch the user's sleep: per-night asleep + stage minutes plus the sleep-rhythm summary (sleep debt + chronotype). Returns { present: false } when no sleep is tracked.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {
        window: {
          type: "string",
          enum: WINDOW_ENUM,
          description: "Analysis window. Defaults to the user's scope window.",
        },
      },
    },
  },
  {
    name: "get_medication_compliance",
    description:
      "Fetch the user's medication compliance: the dose-weighted adherence rate plus a recent timeline, and any GLP-1 titration context. Returns { present: false } when no medications are tracked.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {
        window: {
          type: "string",
          enum: WINDOW_ENUM,
          description: "Analysis window. Defaults to the user's scope window.",
        },
      },
    },
  },
  {
    name: "get_labs",
    description:
      "Fetch the user's most recent lab results — the latest reading per biomarker over the last 12 months, or one named analyte. Returns { present: false } when no labs are on file.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {
        analyte: {
          type: "string",
          description:
            "Optional single biomarker name to filter to (e.g. 'LDL').",
        },
      },
    },
  },
  {
    name: "get_illness_recovery",
    description:
      "Fetch the user's illness + recovery context: rest mode, active and recently-resolved illnesses, and the recovery / strain composites. Returns { present: false } when there is nothing to report.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {},
    },
  },
];
