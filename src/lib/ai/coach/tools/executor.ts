/**
 * v1.20.0 (F1) — Coach retrieval tool executor.
 *
 * Dispatches a single tool call from the model: validates the raw JSON
 * arguments against the tool's Zod schema, runs the existing
 * server-authoritative snapshot builder scoped to just the requested domain,
 * and slices the matching section(s) out of the structured result.
 *
 * GROUNDING CONTRACTS (the hallucination audit hammers these):
 *   - Every tool returns a structured `{ present: boolean }`. When the domain
 *     carries no data — or the user opted out of the owning module — the result
 *     is `{ present: false, reason }`. It NEVER throws and NEVER returns an
 *     ambiguous `[]`, so the model can always tell "no data" from "data".
 *   - Module / cycle gates are enforced AT THE BUILDER (`buildCoachSnapshot`
 *     applies `MODULE_EXCLUDED_SOURCES` + the cycle gate before any row is
 *     read), so an opted-out domain is structurally unfetchable here — the
 *     section simply never appears and the executor reports `present: false`.
 *   - `userId` is the session-narrowed id passed by the route, never a tool
 *     argument. Tools are read-only (snapshot reads only), so there is no
 *     mutation or egress surface.
 *
 * The builder result is memoised by the 60s snapshot LRU keyed on
 * `(userId, window, sources)`. Each tool scopes to a different source set, so
 * tool calls for distinct domains do NOT share a cache entry; sharing happens
 * only when the SAME scope recurs (a repeated call, or a turn that re-enters
 * the same domain) within the 60s window.
 */
import { z } from "zod/v4";

import { annotate } from "@/lib/logging/context";
import { buildCoachSnapshot } from "@/lib/ai/coach/snapshot";
import type { CoachScope, CoachScopeWindow } from "@/lib/ai/coach/types";
import {
  getMetricSeriesArgsSchema,
  getGlucosePanelArgsSchema,
  getSleepArgsSchema,
  getMedicationComplianceArgsSchema,
  getLabsArgsSchema,
  getIllnessRecoveryArgsSchema,
  getWorkoutsArgsSchema,
  getCycleArgsSchema,
  getCorrelationsArgsSchema,
  isCoachToolName,
  type CoachToolName,
} from "./definitions";
import {
  COACH_SOURCE_SNAPSHOT_KEY,
  METRIC_SERIES_EXCLUDED_SOURCES,
} from "./source-keys";
import { readCoachCorrelations } from "./correlations-read";

/** A read-only structured tool result. Serialised to a `role:"tool"` turn. */
export interface CoachToolResult {
  present: boolean;
  /** Short machine reason on a `present: false` result (no PII). */
  reason?: string;
  /** The domain payload on a `present: true` result (the snapshot section). */
  data?: unknown;
  /**
   * Optional citation-coupled reference grounding for the fetched metric —
   * published population bands + the user's placement, general guidance only.
   */
  grounding?: string;
}

/** What the route persists onto provenance: which tools ran, did data exist. */
export interface CoachToolTrace {
  name: string;
  present: boolean;
}

function pickSection(
  sections: Record<string, unknown>,
  key: string,
): unknown | undefined {
  const value = sections[key];
  if (value === undefined || value === null) return undefined;
  return value;
}

/**
 * Resolve `args.window` into a scope. Falls back to the conversation's
 * effective window so a tool call that omits `window` matches the user's
 * chosen analysis window rather than the builder default.
 */
function scopeFor(
  sources: CoachScope["sources"],
  window: CoachScopeWindow | undefined,
  fallbackWindow: CoachScopeWindow | undefined,
): CoachScope {
  return {
    sources,
    window: window ?? fallbackWindow,
  };
}

/**
 * Execute one tool call. `rawArguments` is the model's raw JSON-string
 * arguments (parsed + validated here, never trusted blindly). Returns a
 * grounded `CoachToolResult` — a validation failure or unknown tool resolves
 * to `{ present: false }`, never a throw, so a single bad call can't break the
 * turn.
 */
export async function executeCoachTool(args: {
  userId: string;
  name: string;
  rawArguments: string;
  /** The conversation's effective window, used when a call omits `window`. */
  fallbackWindow?: CoachScopeWindow;
}): Promise<CoachToolResult> {
  const { userId, name, rawArguments, fallbackWindow } = args;

  if (!isCoachToolName(name)) {
    annotate({
      action: { name: "coach.tool.unknown" },
      meta: { tool: name.slice(0, 48) },
    });
    return { present: false, reason: "unknown_tool" };
  }

  let parsedArgs: unknown;
  try {
    parsedArgs = rawArguments.trim() === "" ? {} : JSON.parse(rawArguments);
  } catch {
    annotate({
      action: { name: "coach.tool.bad_arguments" },
      meta: { tool: name, reason: "invalid_json" },
    });
    return { present: false, reason: "invalid_arguments" };
  }

  try {
    const result = await dispatch(name, userId, parsedArgs, fallbackWindow);
    annotate({
      action: { name: "coach.tool.executed" },
      meta: { tool: name, present: result.present },
    });
    return result;
  } catch (err) {
    // A read failure must degrade to a grounded "no data" rather than break
    // the loop — the model then says it could not retrieve the metric.
    annotate({
      action: { name: "coach.tool.error" },
      meta: {
        tool: name,
        reason: err instanceof Error ? err.name : "unknown",
      },
    });
    return { present: false, reason: "retrieval_failed" };
  }
}

async function dispatch(
  name: CoachToolName,
  userId: string,
  rawArgs: unknown,
  fallbackWindow: CoachScopeWindow | undefined,
): Promise<CoachToolResult> {
  switch (name) {
    case "get_metric_series":
      return getMetricSeries(userId, rawArgs, fallbackWindow);
    case "get_glucose_panel":
      return getGlucosePanel(userId, rawArgs, fallbackWindow);
    case "get_sleep":
      return getSleep(userId, rawArgs, fallbackWindow);
    case "get_medication_compliance":
      return getMedicationCompliance(userId, rawArgs, fallbackWindow);
    case "get_labs":
      return getLabs(userId, rawArgs, fallbackWindow);
    case "get_illness_recovery":
      return getIllnessRecovery(userId, fallbackWindow);
    case "get_workouts":
      return getWorkouts(userId, rawArgs, fallbackWindow);
    case "get_cycle":
      return getCycle(userId, rawArgs);
    case "get_correlations":
      return getCorrelations(userId, rawArgs);
  }
}

function badArgs(name: string, error: z.ZodError): CoachToolResult {
  annotate({
    action: { name: "coach.tool.bad_arguments" },
    meta: { tool: name, reason: "schema", issues: error.issues.length },
  });
  return { present: false, reason: "invalid_arguments" };
}

async function getMetricSeries(
  userId: string,
  rawArgs: unknown,
  fallbackWindow: CoachScopeWindow | undefined,
): Promise<CoachToolResult> {
  const parsed = getMetricSeriesArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return badArgs("get_metric_series", parsed.error);
  const { metric, window } = parsed.data;

  // Glucose / workouts / compliance have dedicated tools (or are deferred);
  // refuse to answer them here so the model is pointed at the right tool
  // rather than getting a fabricated-shape miss.
  if (METRIC_SERIES_EXCLUDED_SOURCES.has(metric)) {
    return {
      present: false,
      reason:
        metric === "glucose"
          ? "use_get_glucose_panel"
          : metric === "compliance"
            ? "use_get_medication_compliance"
            : "unsupported_metric",
    };
  }

  const sectionKey = COACH_SOURCE_SNAPSHOT_KEY[metric];
  if (!sectionKey) {
    return { present: false, reason: "unsupported_metric" };
  }

  const snapshot = await buildCoachSnapshot(
    userId,
    scopeFor([metric], window, fallbackWindow),
  );
  const section = pickSection(snapshot.sections, sectionKey);
  if (section === undefined) {
    return { present: false, reason: "no_data" };
  }
  return {
    present: true,
    data: { metric, section },
    grounding: snapshot.referenceGrounding ?? undefined,
  };
}

async function getGlucosePanel(
  userId: string,
  rawArgs: unknown,
  fallbackWindow: CoachScopeWindow | undefined,
): Promise<CoachToolResult> {
  const parsed = getGlucosePanelArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return badArgs("get_glucose_panel", parsed.error);
  const snapshot = await buildCoachSnapshot(
    userId,
    scopeFor(["glucose"], parsed.data.window, fallbackWindow),
  );
  const section = pickSection(snapshot.sections, "glucose");
  if (section === undefined) return { present: false, reason: "no_data" };
  return {
    present: true,
    data: section,
    grounding: snapshot.referenceGrounding ?? undefined,
  };
}

async function getSleep(
  userId: string,
  rawArgs: unknown,
  fallbackWindow: CoachScopeWindow | undefined,
): Promise<CoachToolResult> {
  const parsed = getSleepArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return badArgs("get_sleep", parsed.error);
  const snapshot = await buildCoachSnapshot(
    userId,
    scopeFor(["sleep"], parsed.data.window, fallbackWindow),
  );
  const nights = pickSection(snapshot.sections, "sleep");
  const rhythm = pickSection(snapshot.sections, "sleepRhythm");
  if (nights === undefined && rhythm === undefined) {
    return { present: false, reason: "no_data" };
  }
  return {
    present: true,
    data: {
      ...(nights !== undefined ? { nights } : {}),
      ...(rhythm !== undefined ? { rhythm } : {}),
    },
    grounding: snapshot.referenceGrounding ?? undefined,
  };
}

async function getMedicationCompliance(
  userId: string,
  rawArgs: unknown,
  fallbackWindow: CoachScopeWindow | undefined,
): Promise<CoachToolResult> {
  const parsed = getMedicationComplianceArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return badArgs("get_medication_compliance", parsed.error);
  }
  const snapshot = await buildCoachSnapshot(
    userId,
    scopeFor(["compliance"], parsed.data.window, fallbackWindow),
  );
  const compliance = pickSection(snapshot.sections, "compliance");
  // GLP-1 context rides the `weeklyContext` block.
  const weeklyContext = pickSection(snapshot.sections, "weeklyContext") as
    | { glp1?: unknown }
    | undefined;
  const glp1 = weeklyContext?.glp1;
  if (compliance === undefined && glp1 === undefined) {
    return { present: false, reason: "no_data" };
  }
  return {
    present: true,
    data: {
      ...(compliance !== undefined ? { compliance } : {}),
      ...(glp1 !== undefined ? { glp1 } : {}),
    },
  };
}

async function getLabs(
  userId: string,
  rawArgs: unknown,
  fallbackWindow: CoachScopeWindow | undefined,
): Promise<CoachToolResult> {
  const parsed = getLabsArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return badArgs("get_labs", parsed.error);
  // Labs ride the snapshot regardless of `sources` (attached unconditionally),
  // so a minimal scope still surfaces them. Pass an empty source set to keep
  // the read tight.
  //
  // v1.21.0 (A5-F4) — the labs block itself is a "latest reading per biomarker
  // over the last 12 months" snapshot and is intentionally window-AGNOSTIC
  // (the read cutoff is fixed). We still thread the conversation's window onto
  // the scope so the snapshot's `scope` block reports the right horizon for the
  // turn; it does not move the labs read.
  const snapshot = await buildCoachSnapshot(userId, {
    sources: [],
    window: fallbackWindow,
  });
  const labs = pickSection(snapshot.sections, "labs") as
    | { recent?: Array<{ name?: string; analyte?: string }> }
    | undefined;
  if (labs === undefined) return { present: false, reason: "no_data" };

  const analyte = parsed.data.analyte?.trim().toLowerCase();
  if (analyte && Array.isArray(labs.recent)) {
    const filtered = labs.recent.filter((entry) => {
      const haystack =
        `${entry.name ?? ""} ${entry.analyte ?? ""}`.toLowerCase();
      return haystack.includes(analyte);
    });
    if (filtered.length === 0) {
      return { present: false, reason: "analyte_not_found" };
    }
    return { present: true, data: { recent: filtered } };
  }
  return { present: true, data: labs };
}

async function getIllnessRecovery(
  userId: string,
  fallbackWindow: CoachScopeWindow | undefined,
): Promise<CoachToolResult> {
  // Validate the (empty) args shape for consistency; an empty object always
  // passes.
  getIllnessRecoveryArgsSchema.parse({});
  // Recovery composites gate on the `recovery` module + the HRV/RHR/VO2max
  // sources; request them so the derived / dayStrain / trajectory blocks can
  // build when the module is on. Illness rides the snapshot unconditionally.
  //
  // v1.21.0 (A5-F4) — honour the conversation's window so the recovery/strain/
  // trajectory composites are computed over the horizon the caller asked for
  // rather than the builder default.
  const snapshot = await buildCoachSnapshot(userId, {
    sources: ["hrv", "resting_hr", "vo2_max"],
    window: fallbackWindow,
  });
  const illness = pickSection(snapshot.sections, "illness");
  const derived = pickSection(snapshot.sections, "derived");
  const dayStrain = pickSection(snapshot.sections, "dayStrain");
  const trajectory = pickSection(snapshot.sections, "trajectory");
  if (
    illness === undefined &&
    derived === undefined &&
    dayStrain === undefined &&
    trajectory === undefined
  ) {
    return { present: false, reason: "no_data" };
  }
  return {
    present: true,
    data: {
      ...(illness !== undefined ? { illness } : {}),
      ...(derived !== undefined ? { derived } : {}),
      ...(dayStrain !== undefined ? { dayStrain } : {}),
      ...(trajectory !== undefined ? { trajectory } : {}),
    },
  };
}

async function getWorkouts(
  userId: string,
  rawArgs: unknown,
  fallbackWindow: CoachScopeWindow | undefined,
): Promise<CoachToolResult> {
  const parsed = getWorkoutsArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return badArgs("get_workouts", parsed.error);
  // The workouts block builds when the `workouts` cluster is active AND the
  // user has workout rows in the window. Scope the read to that single source.
  const snapshot = await buildCoachSnapshot(
    userId,
    scopeFor(["workouts"], parsed.data.window, fallbackWindow),
  );
  const workouts = pickSection(snapshot.sections, "workouts");
  if (workouts === undefined) return { present: false, reason: "no_data" };
  return { present: true, data: workouts };
}

async function getCycle(
  userId: string,
  rawArgs: unknown,
): Promise<CoachToolResult> {
  const parsed = getCycleArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return badArgs("get_cycle", parsed.error);
  // The cycle block is gated INSIDE the builder by `isCycleAvailableForUser`
  // (the per-user toggle AND the operator switch), independent of `sources` —
  // so a minimal scope still surfaces it when the account tracks cycles, and a
  // non-cycle account structurally produces no block (→ present:false).
  const snapshot = await buildCoachSnapshot(userId, { sources: [] });
  const cycle = pickSection(snapshot.sections, "cycle");
  if (cycle === undefined) return { present: false, reason: "no_data" };
  return { present: true, data: cycle };
}

async function getCorrelations(
  userId: string,
  rawArgs: unknown,
): Promise<CoachToolResult> {
  const parsed = getCorrelationsArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return badArgs("get_correlations", parsed.error);
  // Reads the deterministic FDR discovery + coincident-deviation flag; returns
  // a clean `{ present: false }` when too little paired data exists.
  const result = await readCoachCorrelations(userId);
  if (!result.present) {
    return { present: false, reason: result.reason ?? "no_data" };
  }
  return {
    present: true,
    data: {
      ...(result.drivers ? { drivers: result.drivers } : {}),
      ...(result.coincident ? { coincident: result.coincident } : {}),
      pairsTested: result.pairsTested,
      windowDays: result.windowDays,
    },
  };
}
