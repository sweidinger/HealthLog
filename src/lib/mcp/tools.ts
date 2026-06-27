/**
 * Transport-agnostic MCP read-tool registry.
 *
 * Each tool is a THIN wrapper over an existing server-authoritative read path —
 * the Coach F1 retrieval layer (`@/lib/ai/coach/tools`). No new analytics is
 * computed here (REQ-WONT-2); the MCP wire only re-exports what HealthLog
 * already computes. The same registry feeds both transports: the stdio adapter
 * (this phase) and the remote `/mcp` adapter (a later phase) register from it,
 * so the tool contract can never fork between wires (ADR-002).
 *
 * Grounding contract (REQ-SEC-2/3/4, ADR-004): every tool returns structured
 * values + units + reference bands + provenance and uses `{ present: false }`
 * for absence — never a silent zero, never a prose verdict or diagnosis. The
 * assistant narrates; the server only ships facts it computed.
 *
 * Read-only contract (REQ-SEC-1, ADR-003): the registry contains read tools
 * only. `userId` is always taken from the resolved session context, never from a
 * tool argument (REQ-SEC-5).
 */
import { z } from "zod/v4";

import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { executeCoachTool } from "@/lib/ai/coach/tools/executor";
import { buildCoachDataInventory } from "@/lib/ai/coach/tools/inventory";
import {
  coachScopeSourceSchema,
  coachScopeWindowSchema,
} from "@/lib/ai/coach/types";
import { resolveBaseOrigin } from "@/lib/mcp/oauth/config";
import {
  getCorrelation,
  compareMetric,
  getMetricBaseline,
  detectChangepoints,
  getLabHistory,
  LAB_HISTORY_MAX_LIMIT,
  type DateRange,
} from "@/lib/mcp/rich-reads";
import { encodeOffsetCursor, decodeOffsetCursor } from "@/lib/mcp/pagination";
import type { McpAuthContext } from "./auth";

/**
 * Tool annotations (MCP 2025-11-25). The cloud connectors REQUIRE these on every
 * tool — the ChatGPT Apps SDK treats an omitted hint as a validation error, and
 * the Claude directory requires a safety hint per tool. Every tool the MCP
 * surface exposes is read-only over a closed personal record, so they all share
 * the same shape (ADR-003): the read-only guarantee is structural, the
 * annotation merely advertises it.
 */
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/**
 * A registry entry. `inputShape` is a zod/v4 raw shape handed straight to the
 * SDK's `registerTool` for argument validation; `run` receives the validated
 * arguments and the session context and returns a plain structured object.
 */
export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  inputShape: z.ZodRawShape;
  /** Tool annotations — mandatory for the cloud connectors (see above). */
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  /**
   * When set, the tool declares a structured `outputSchema` and its result is
   * returned as `structuredContent`. Used by `search` / `fetch` so ChatGPT can
   * consume the exact `{id,title,url}[]` / `{id,title,text,url,metadata}` shapes.
   */
  outputShape?: z.ZodRawShape;
  run: (ctx: McpAuthContext, args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Run one Coach F1 retrieval tool through its executor. The executor re-parses
 * and re-validates the arguments against its own Zod schema, runs the
 * server-authoritative snapshot builder scoped to the requested domain, and
 * returns the grounded `{ present, reason?, data?, grounding? }` result. It
 * never throws and never widens scope.
 */
async function runCoachTool(
  ctx: McpAuthContext,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = await executeCoachTool({
    userId: ctx.userId,
    name,
    rawArguments: JSON.stringify(args ?? {}),
  });
  annotate({
    action: { name: "mcp.tool.invoked" },
    meta: { tool: name, present: result.present },
  });
  return result;
}

/** Finite-number guard for the citation summarisers. */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Render a `fetch` result for a metric id as a short, human-readable citation
 * sentence (NOT a JSON blob). Pulls the recent aggregate + the grounding band
 * out of the server-authoritative result; falls back to a plain factual line
 * when a field is absent. Never fabricates a number the result did not carry.
 */
function plainMetricText(rid: string, result: unknown): string {
  const r = result as {
    present?: boolean;
    data?: { section?: Record<string, unknown> } & Record<string, unknown>;
    grounding?: string;
  };
  if (!r?.present) return `No recent ${rid} data is on file.`;
  const section = (r.data?.section ?? r.data) as
    | Record<string, unknown>
    | undefined;
  const agg = section?.aggregate as Record<string, unknown> | undefined;
  const parts: string[] = [];
  const mean = num(agg?.mean);
  const count = num(agg?.count);
  if (mean !== null) parts.push(`recent mean ${round1(mean)}`);
  if (count !== null) parts.push(`${count} readings`);
  const head =
    parts.length > 0
      ? `${rid}: ${parts.join(", ")}.`
      : `${rid}: data is available for the recent window.`;
  return [head, typeof r.grounding === "string" ? r.grounding : ""]
    .filter(Boolean)
    .join(" ");
}

/**
 * Render a `fetch` result for a lab analyte id as a short citation sentence,
 * quoting the latest reading's value/unit/status/date verbatim from the
 * server-authoritative result.
 */
function plainLabText(rid: string, result: unknown): string {
  const r = result as {
    present?: boolean;
    data?: { recent?: Array<Record<string, unknown>> };
  };
  if (!r?.present) return `No lab result for ${rid} is on file.`;
  const reading = Array.isArray(r.data?.recent) ? r.data!.recent[0] : undefined;
  if (!reading) return `${rid}: a reading is on file.`;
  const analyte = typeof reading.analyte === "string" ? reading.analyte : rid;
  const value =
    reading.value != null
      ? String(reading.value)
      : typeof reading.valueText === "string"
        ? reading.valueText
        : "—";
  const unit = typeof reading.unit === "string" ? reading.unit : "";
  const status =
    typeof reading.rangeStatus === "string" ? reading.rangeStatus : "";
  const taken =
    typeof reading.takenAt === "string" ? reading.takenAt.slice(0, 10) : "";
  return (
    `${analyte}: ${value}${unit ? ` ${unit}` : ""}` +
    `${status && status !== "unknown" ? ` (${status})` : ""}` +
    `${taken ? `, measured ${taken}` : ""}.`
  );
}

/**
 * The `search` + `fetch` pair — the de-facto two-tool retrieval convention and,
 * critically, the ONLY tools ChatGPT can call in its default (non-Developer)
 * mode. Without them HealthLog is invisible in default ChatGPT. The exact wire
 * shapes are mandated by OpenAI:
 *
 *   - `search({ query })` → `{ results: [{ id, title, url }] }`
 *   - `fetch({ id })`     → `{ id, title, text, url, metadata? }`
 *
 * Every result carries a REAL, user-openable HTTPS deep link (`url`) into the
 * HealthLog web app — ChatGPT only creates citation metadata when `url` is a
 * non-empty string. The internal `id` stays separate from `url`. Both tools are
 * thin façades over the SAME server-authoritative read paths the other tools
 * use; free-text fields (medication names, lab analytes) are returned as DATA,
 * never interpreted as instructions (R-SEC-2).
 */
function searchAndFetchTools(): McpToolDefinition[] {
  return [
    {
      name: "search",
      title: "Search your health records",
      description:
        "Search the user's own health record — metric domains, medications, and lab biomarkers — for items matching a free-text query. Returns { results: [{ id, title, url }], nextCursor? }; pass an id to the `fetch` tool to hydrate it. Each `url` deep-links into the HealthLog web app for citation. When more results exist, pass the opaque `nextCursor` back as `cursor` for the next page. Returns an empty list when nothing matches.",
      inputShape: {
        query: z.string().max(200),
        cursor: z
          .string()
          .max(256)
          .optional()
          .describe(
            "Opaque pagination cursor from a previous response's nextCursor. Treat as a black box; do not construct one.",
          ),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      outputShape: {
        results: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            url: z.string(),
          }),
        ),
        nextCursor: z.string().optional(),
      },
      async run(ctx, args) {
        const query =
          typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
        const origin = resolveBaseOrigin();
        const results: Array<{ id: string; title: string; url: string }> = [];

        const inventory = await buildCoachDataInventory(ctx.userId, undefined);
        for (const entry of inventory.entries) {
          if (!entry.present) continue;
          const hay = `${entry.domain} ${entry.metric ?? ""}`.toLowerCase();
          if (query && !hay.includes(query)) continue;
          results.push({
            id: entry.metric
              ? `metric:${entry.metric}`
              : `domain:${entry.domain}`,
            title: entry.domain,
            url: `${origin}/insights`,
          });
        }

        const meds = await prisma.medication.findMany({
          where: { userId: ctx.userId },
          select: { id: true, name: true, dose: true },
          orderBy: { createdAt: "desc" },
          take: 200,
        });
        for (const med of meds) {
          if (query && !med.name.toLowerCase().includes(query)) continue;
          results.push({
            id: `med:${med.id}`,
            title: med.dose ? `${med.name} ${med.dose}` : med.name,
            url: `${origin}/medications`,
          });
        }

        const labs = await prisma.labResult.findMany({
          where: { userId: ctx.userId, deletedAt: null },
          select: { analyte: true },
          distinct: ["analyte"],
          take: 200,
        });
        for (const lab of labs) {
          if (query && !lab.analyte.toLowerCase().includes(query)) continue;
          results.push({
            id: `lab:${lab.analyte}`,
            title: lab.analyte,
            url: `${origin}/labs`,
          });
        }

        // Cursor pagination over the assembled result set (was a silent
        // slice(0,50)). The set is rebuilt deterministically each call (stable
        // ordering: metrics → medications → labs), so an opaque offset cursor
        // pages it reliably and the response stays token-bounded.
        const offset = decodeOffsetCursor(args.cursor);
        const page = results.slice(offset, offset + SEARCH_PAGE_SIZE);
        const hasMore = offset + SEARCH_PAGE_SIZE < results.length;
        annotate({
          action: { name: "mcp.tool.invoked" },
          meta: { tool: "search", present: page.length > 0 },
        });
        return {
          results: page,
          ...(hasMore
            ? { nextCursor: encodeOffsetCursor(offset + SEARCH_PAGE_SIZE) }
            : {}),
        };
      },
    },
    {
      name: "fetch",
      title: "Fetch one health record",
      description:
        "Hydrate a single record returned by `search`, by its id (e.g. `metric:weight`, `med:<id>`, `lab:LDL`). Returns { id, title, text, url, metadata } where `text` is a server-authoritative, plain-text prose summary suitable for citation and `url` deep-links to the specific record in HealthLog. Returns a not-found message when the id does not resolve.",
      inputShape: { id: z.string().min(1).max(200) },
      annotations: READ_ONLY_ANNOTATIONS,
      outputShape: {
        id: z.string(),
        title: z.string(),
        text: z.string(),
        url: z.string(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
      async run(ctx, args) {
        const id = typeof args.id === "string" ? args.id : "";
        const origin = resolveBaseOrigin();
        const sep = id.indexOf(":");
        const kind = sep > 0 ? id.slice(0, sep) : "";
        const rid = sep > 0 ? id.slice(sep + 1) : "";

        annotate({
          action: { name: "mcp.tool.invoked" },
          meta: { tool: "fetch", kind: kind || "unknown" },
        });

        if (kind === "metric" && rid) {
          const result = await executeCoachTool({
            userId: ctx.userId,
            name: "get_metric_series",
            rawArguments: JSON.stringify({ metric: rid }),
          });
          return {
            id,
            title: rid,
            text: plainMetricText(rid, result),
            // The metric page deep-link; the insights surface renders the series.
            url: `${origin}/insights?metric=${encodeURIComponent(rid)}`,
            metadata: { type: "metric", metric: rid },
          };
        }

        if (kind === "lab" && rid) {
          const result = await executeCoachTool({
            userId: ctx.userId,
            name: "get_labs",
            rawArguments: JSON.stringify({ analyte: rid }),
          });
          return {
            id,
            title: rid,
            text: plainLabText(rid, result),
            // Deep-link to the labs surface filtered to this analyte.
            url: `${origin}/labs?analyte=${encodeURIComponent(rid)}`,
            metadata: { type: "lab", analyte: rid },
          };
        }

        if (kind === "med" && rid) {
          const med = await prisma.medication.findFirst({
            where: { id: rid, userId: ctx.userId },
            select: {
              name: true,
              dose: true,
              treatmentClass: true,
              asNeeded: true,
            },
          });
          if (!med) {
            return {
              id,
              title: "Not found",
              text: "No medication matches this id.",
              url: `${origin}/medications`,
              metadata: { type: "medication" },
            };
          }
          // Plain-text prose, not a JSON blob. `dose` / `treatmentClass` are
          // user-controlled free-text returned as DATA, never interpreted.
          const text =
            `${med.name}${med.dose ? ` ${med.dose}` : ""}` +
            `${med.asNeeded ? " (as needed)" : ""}` +
            `${med.treatmentClass ? ` — ${med.treatmentClass}` : ""}.`;
          return {
            id,
            title: med.name,
            text,
            // Per-item deep-link to the medication detail page.
            url: `${origin}/medications/${encodeURIComponent(rid)}`,
            metadata: { type: "medication", medicationId: rid },
          };
        }

        return {
          id,
          title: "Not found",
          text: `No record matches the id "${id}".`,
          url: `${origin}/insights`,
          metadata: { type: "unknown" },
        };
      },
    },
  ];
}

// ── Output schemas ───────────────────────────────────────────────────
// Every field except the presence anchor (`present`) is optional so a grounded
// `{ present: false }` miss and a full hit both conform — the SDK validates the
// returned `structuredContent` against these (ChatGPT Apps-SDK conformance).

const bandShape = z
  .object({ low: z.number(), high: z.number() })
  .nullable()
  .optional();

/**
 * The shared output shape for the Coach-F1-backed reads (`get_metric_series`,
 * `get_glucose_panel`, `get_sleep`, `get_workouts`, `get_illness_recovery`,
 * `get_cycle`, `get_medication_compliance`, `get_correlations`). The executor
 * returns the grounded `{ present, reason?, data?, grounding? }` contract; `data`
 * is the server-authoritative domain section (its inner shape is the snapshot's,
 * carried opaque here) so both a miss and a full hit validate.
 */
const coachReadOutput: z.ZodRawShape = {
  present: z.boolean(),
  reason: z.string().optional(),
  data: z.unknown().optional(),
  grounding: z.string().optional(),
};

/**
 * Optional explicit `{from,to}` ISO date range that the comparison /
 * changepoint reads accept IN PLACE OF one of the five fixed trailing windows.
 * Bounds are inclusive; the read serves the range over the same rollup tier the
 * trailing windows use (see `rich-reads.ts`).
 */
const dateRangeShape = z
  .object({
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
  })
  .describe(
    "An explicit inclusive date range. Use INSTEAD OF `window` for an arbitrary span (e.g. before vs after a date). Both bounds are ISO-8601 instants.",
  );

/** Cap on metrics fetched in one `get_metrics` call (paginated past the cap). */
const MAX_METRICS_PER_CALL = 24;
/** Metrics resolved per `get_metrics` page. */
const METRICS_PAGE_SIZE = 8;
/** Results per `search` page. */
const SEARCH_PAGE_SIZE = 50;

const getCorrelationOutput: z.ZodRawShape = {
  present: z.boolean(),
  reason: z.string().optional(),
  pair: z
    .object({
      behaviour: z.string(),
      outcome: z.string(),
      direction: z.enum(["higher", "lower"]),
      lagDays: z.number(),
      n: z.number(),
      r: z.number(),
      note: z.string(),
    })
    .optional(),
  pairsTested: z.number().optional(),
  windowDays: z.number().optional(),
  association: z.literal("descriptive").optional(),
};

const metricWindowSnapshotSchema = z.object({
  label: z.string(),
  unit: z.string(),
  band: bandShape,
  windowDays: z.number(),
  granularity: z.string(),
  count: z.number(),
  mean: z.number().nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  // Present only when the side was an explicit `{from,to}` range.
  from: z.string().optional(),
  to: z.string().optional(),
});

/** Output schema for `list_metrics` — the inventory rows + flags. */
const listMetricsOutput: z.ZodRawShape = {
  present: z.boolean(),
  window: z.string().optional(),
  restMode: z.boolean().optional(),
  cycleEnabled: z.boolean().optional(),
  metrics: z
    .array(
      z.object({
        tool: z.string(),
        domain: z.string(),
        present: z.boolean(),
        count: z.number().optional(),
        metric: z.string().optional(),
      }),
    )
    .optional(),
};

/** Output schema for `get_labs` — latest-per-biomarker OR a paginated history. */
const getLabsOutput: z.ZodRawShape = {
  present: z.boolean(),
  reason: z.string().optional(),
  // Latest-mode payload (the Coach labs section, carried opaque).
  data: z.unknown().optional(),
  grounding: z.string().optional(),
  // History-mode payload (per-analyte trajectory + pagination).
  analyte: z.string().optional(),
  readings: z
    .array(
      z.object({
        value: z.number().nullable(),
        valueText: z.string().nullable(),
        unit: z.string(),
        referenceLow: z.number().nullable(),
        referenceHigh: z.number().nullable(),
        rangeStatus: z.enum(["in-range", "below", "above", "unknown"]),
        takenAt: z.string(),
      }),
    )
    .optional(),
  nextCursor: z.string().optional(),
};

/** Output schema for `get_metrics` — the multi-metric fan-out + pagination. */
const getMetricsOutput: z.ZodRawShape = {
  present: z.boolean(),
  window: z.string().optional(),
  results: z
    .array(
      z.object({
        metric: z.string(),
        present: z.boolean(),
        reason: z.string().optional(),
        data: z.unknown().optional(),
        grounding: z.string().optional(),
      }),
    )
    .optional(),
  nextCursor: z.string().optional(),
};

const compareMetricOutput: z.ZodRawShape = {
  present: z.boolean(),
  reason: z.string().optional(),
  mode: z.enum(["metric_vs_metric", "window_vs_window"]).optional(),
  a: metricWindowSnapshotSchema.optional(),
  b: metricWindowSnapshotSchema.optional(),
  delta: z
    .object({ mean: z.number(), pct: z.number().nullable() })
    .nullable()
    .optional(),
};

const getMetricBaselineOutput: z.ZodRawShape = {
  present: z.boolean(),
  reason: z.string().optional(),
  metric: z.string().optional(),
  unit: z.string().optional(),
  baseline: z
    .object({ low: z.number(), high: z.number(), sampleDays: z.number() })
    .optional(),
  latest: z.number().optional(),
  placement: z.enum(["within", "above", "below"]).optional(),
  referenceBand: bandShape,
  driver: z
    .object({ note: z.string(), behaviour: z.string(), outcome: z.string() })
    .nullable()
    .optional(),
};

const detectChangepointsOutput: z.ZodRawShape = {
  present: z.boolean(),
  reason: z.string().optional(),
  metric: z.string().optional(),
  unit: z.string().optional(),
  granularity: z.string().optional(),
  windowDays: z.number().optional(),
  bucketsAnalysed: z.number().optional(),
  changepoints: z
    .array(
      z.object({
        at: z.string(),
        direction: z.enum(["increase", "decrease"]),
        beforeMean: z.number(),
        afterMean: z.number(),
        delta: z.number(),
      }),
    )
    .optional(),
};

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "list_metrics",
    title: "List available metrics",
    description:
      "Enumerate which of the user's health data exists and how to fetch it: one row per domain with whether data is present, an approximate sample count, and the tool that retrieves it. Call this first to discover what is available before fetching figures.",
    inputShape: {},
    annotations: READ_ONLY_ANNOTATIONS,
    outputShape: listMetricsOutput,
    async run(ctx) {
      const inventory = await buildCoachDataInventory(ctx.userId, undefined);
      annotate({
        action: { name: "mcp.tool.invoked" },
        meta: { tool: "list_metrics", present: true },
      });
      return {
        present: true,
        window: inventory.window,
        restMode: inventory.restMode,
        cycleEnabled: inventory.cycleEnabled,
        metrics: inventory.entries,
      };
    },
  },
  {
    name: "get_metric_series",
    title: "Get a metric time series",
    description:
      "Fetch the user's own time series for ONE metric (e.g. bp, weight, pulse, hrv, resting_hr, steps, sleep, body composition, vo2_max). Returns an aggregate (count, min, max, mean, slope) plus recent-daily and weekly timelines, with units and population reference bands for safe phrasing. Returns { present: false } when the user has no data for that metric.",
    inputShape: {
      metric: coachScopeSourceSchema,
      window: coachScopeWindowSchema.optional(),
    },
    annotations: READ_ONLY_ANNOTATIONS,
    outputShape: coachReadOutput,
    run(ctx, args) {
      return runCoachTool(ctx, "get_metric_series", args);
    },
  },
  {
    name: "get_medication_compliance",
    title: "Get medication compliance",
    description:
      "Fetch the user's cadence-aware medication adherence: the dose-weighted compliance rate, expected vs taken/missed counts, current-cycle status, and any GLP-1 titration context. Returns { present: false } when no medications are tracked.",
    inputShape: {
      window: coachScopeWindowSchema.optional(),
    },
    annotations: READ_ONLY_ANNOTATIONS,
    outputShape: coachReadOutput,
    run(ctx, args) {
      return runCoachTool(ctx, "get_medication_compliance", args);
    },
  },
  {
    name: "get_labs",
    title: "Get lab results",
    description:
      "Fetch the user's lab results. By default returns the latest reading per biomarker over the last 12 months, optionally filtered to one named analyte. Pass history:true with an analyte to return that analyte's reading TRAJECTORY (newest first, paginated). Each reading carries its value, unit, reference range, and in-range/below/above status. Returns { present: false } when no labs match.",
    inputShape: {
      analyte: z.string().min(1).max(80).optional(),
      history: z
        .boolean()
        .optional()
        .describe(
          "When true (requires `analyte`), return that analyte's full reading trajectory (newest first, paginated) instead of the latest-per-biomarker snapshot.",
        ),
      cursor: z
        .string()
        .max(256)
        .optional()
        .describe(
          "Opaque pagination cursor from a previous history response's nextCursor. Treat as a black box.",
        ),
    },
    annotations: READ_ONLY_ANNOTATIONS,
    outputShape: getLabsOutput,
    run(ctx, args) {
      // History mode: one analyte's paginated trajectory over the labs read
      // path. Requires an analyte — there is no whole-record history dump.
      if (args.history === true) {
        const analyte = typeof args.analyte === "string" ? args.analyte : "";
        if (!analyte.trim()) {
          return Promise.resolve({
            present: false,
            reason: "analyte_required_for_history",
          });
        }
        return getLabHistory(ctx.userId, {
          analyte,
          offset: decodeOffsetCursor(args.cursor),
          limit: LAB_HISTORY_MAX_LIMIT,
        });
      }
      // Default: latest reading per biomarker via the Coach labs read.
      return runCoachTool(ctx, "get_labs", {
        ...(typeof args.analyte === "string" ? { analyte: args.analyte } : {}),
      });
    },
  },
  {
    name: "get_correlations",
    title: "Get discovered correlations",
    description:
      "Fetch the user's statistically-vetted (FDR-controlled) day-to-next-day driver pairs between behaviours (daylight, mood, glucose, blood pressure, steps) and outcomes (sleep, HRV, resting HR, weight), each with direction, lag, sample size, and a descriptive — never causal — note over a fixed trailing window. Returns { present: false } when too little paired data exists.",
    inputShape: {},
    annotations: READ_ONLY_ANNOTATIONS,
    outputShape: coachReadOutput,
    run(ctx, args) {
      return runCoachTool(ctx, "get_correlations", args);
    },
  },
  // ── Phase 4 deep-value reads (catalogue §5 #1, #3, #4, #7) ──────────
  {
    name: "get_correlation",
    title: "Get a correlation between two metrics",
    description:
      "Fetch the statistically-vetted (FDR-controlled), lag-aware association between TWO named metrics the user tracks (e.g. 'sleep' and 'resting heart rate'). Re-exports the same discovery engine the other correlation surfaces run; returns the matched pair's direction, lag, sample size, Pearson r, and a descriptive — never causal — note. Returns { present: false } when no significant pattern links the pair (sparse data or the link did not clear the engine's floors).",
    inputShape: {
      metricA: z.string().min(1).max(60),
      metricB: z.string().min(1).max(60),
    },
    annotations: READ_ONLY_ANNOTATIONS,
    outputShape: getCorrelationOutput,
    run(ctx, args) {
      return getCorrelation(ctx.userId, {
        metricA: String(args.metricA ?? ""),
        metricB: String(args.metricB ?? ""),
      });
    },
  },
  {
    name: "compare_metric",
    title: "Compare metrics or windows",
    description:
      "Compare one metric against another over the same horizon, OR a single metric across two horizons. A horizon is either one of the five fixed trailing windows OR an explicit {from,to} date range (use `range`/`rangeB` for before-vs-after-a-date). Returns each side's rollup statistics (count, mean, min, max) with units and reference bands, plus a delta + percent change when both sides share a unit. Returns { present: false } when a side has no data.",
    inputShape: {
      metric: z.string().min(1).max(60),
      metricB: z.string().min(1).max(60).optional(),
      window: coachScopeWindowSchema.optional(),
      windowB: coachScopeWindowSchema.optional(),
      range: dateRangeShape.optional(),
      rangeB: dateRangeShape.optional(),
    },
    annotations: READ_ONLY_ANNOTATIONS,
    outputShape: compareMetricOutput,
    run(ctx, args) {
      return compareMetric(ctx.userId, {
        metric: String(args.metric ?? ""),
        metricB: typeof args.metricB === "string" ? args.metricB : undefined,
        window: args.window as never,
        windowB: args.windowB as never,
        range: args.range as DateRange | undefined,
        rangeB: args.rangeB as DateRange | undefined,
      });
    },
  },
  {
    name: "get_metric_baseline",
    title: "Get a metric's personal baseline",
    description:
      "Fetch where the user's latest reading for ONE metric sits against their own usual range (median ± robust deviation), plus the strongest lagged driver of that metric. Re-exports the same baseline engine the metric page renders. Returns the personal band, today's value + placement (within/above/below), and the population reference band. Returns { present: false } with reason 'insufficient_history' below the 7-day learning floor — never a fabricated range.",
    inputShape: {
      metric: z.string().min(1).max(60),
    },
    annotations: READ_ONLY_ANNOTATIONS,
    outputShape: getMetricBaselineOutput,
    run(ctx, args) {
      return getMetricBaseline(ctx.userId, {
        metric: String(args.metric ?? ""),
      });
    },
  },
  {
    name: "detect_changepoints",
    title: "Detect level shifts in a metric",
    description:
      "Surface points where a metric's level shifted over a trailing window OR an explicit {from,to} date range (e.g. 'when did my weight trend change?'). Runs a conservative changepoint scan over the rollup tier's bucket means and reports each shift's date, direction, and before/after means with units. High firing bar — returns { present: false } when too little data exists or no shift clears the threshold.",
    inputShape: {
      metric: z.string().min(1).max(60),
      window: coachScopeWindowSchema.optional(),
      range: dateRangeShape.optional(),
    },
    annotations: READ_ONLY_ANNOTATIONS,
    outputShape: detectChangepointsOutput,
    run(ctx, args) {
      return detectChangepoints(ctx.userId, {
        metric: String(args.metric ?? ""),
        window: args.window as never,
        range: args.range as DateRange | undefined,
      });
    },
  },
  // ── Coach-F1 reads bridged to the wire (catalogue Tier 1) ───────────
  // Each is a thin `runCoachTool` glue over an already-built, grounded Coach
  // retrieval tool — same gates, units, and `{ present: false }` contract. The
  // `list_metrics` inventory already advertises these, so wiring them here
  // closes the prior advertise-but-missing self-inconsistency.
  {
    name: "get_glucose_panel",
    title: "Get the glucose panel",
    description:
      "Fetch the user's glucose data: per-context daily means plus the trailing-30-day clinical panel (time-in-range, GMI, CV%, estimated A1c). Returns { present: false } when the user logs no glucose.",
    inputShape: {
      window: coachScopeWindowSchema.optional(),
    },
    annotations: READ_ONLY_ANNOTATIONS,
    outputShape: coachReadOutput,
    run(ctx, args) {
      return runCoachTool(ctx, "get_glucose_panel", args);
    },
  },
  {
    name: "get_sleep",
    title: "Get sleep",
    description:
      "Fetch the user's sleep: per-night asleep + stage minutes plus the sleep-rhythm summary (sleep debt + chronotype). Returns { present: false } when no sleep is tracked.",
    inputShape: {
      window: coachScopeWindowSchema.optional(),
    },
    annotations: READ_ONLY_ANNOTATIONS,
    outputShape: coachReadOutput,
    run(ctx, args) {
      return runCoachTool(ctx, "get_sleep", args);
    },
  },
  {
    name: "get_workouts",
    title: "Get workouts",
    description:
      "Fetch the user's workouts: the most recent sessions (sport, duration, energy, distance, avg/max HR) plus a per-sport rollup over the window. Use for training-load and 'how were my runs / am I overtraining?' questions. Returns { present: false } when no workouts are tracked.",
    inputShape: {
      window: coachScopeWindowSchema.optional(),
    },
    annotations: READ_ONLY_ANNOTATIONS,
    outputShape: coachReadOutput,
    run(ctx, args) {
      return runCoachTool(ctx, "get_workouts", args);
    },
  },
  {
    name: "get_illness_recovery",
    title: "Get illness & recovery",
    description:
      "Fetch the user's illness + recovery context: rest mode, active and recently-resolved illnesses, the recovery / strain composites, and the illness retrospective (recovery-gap, nadir, red flags). Carries the rest-mode safety flag for framing. Returns { present: false } when there is nothing to report.",
    inputShape: {},
    annotations: READ_ONLY_ANNOTATIONS,
    outputShape: coachReadOutput,
    run(ctx, args) {
      return runCoachTool(ctx, "get_illness_recovery", args);
    },
  },
  {
    name: "get_cycle",
    title: "Get menstrual cycle",
    description:
      "Fetch the user's menstrual-cycle context: current phase + day-of-cycle, the next predicted event, and the headline phase-correlation finding. Descriptive only — never a contraception-grade or 'safe day' claim. Gated on cycle tracking being enabled for the account; returns { present: false } when cycle tracking is off or there is no data.",
    inputShape: {},
    annotations: READ_ONLY_ANNOTATIONS,
    outputShape: coachReadOutput,
    run(ctx, args) {
      return runCoachTool(ctx, "get_cycle", args);
    },
  },
  // ── Multi-metric fan-out (catalogue: query expressiveness) ──────────
  {
    name: "get_metrics",
    title: "Get several metric series at once",
    description:
      "Fetch the time series for SEVERAL metrics in one call — a fan-out over the same single-metric read `get_metric_series` runs, returning one grounded result per metric (each with { present } and the metric's aggregate/timelines when present). Paginated: when more metrics remain than fit one page, pass the opaque nextCursor back as `cursor`. Use for a multi-metric question instead of many separate calls.",
    inputShape: {
      metrics: z
        .array(z.string().min(1).max(60))
        .min(1)
        .max(MAX_METRICS_PER_CALL)
        .describe(
          "The metrics to fetch (e.g. ['weight','pulse','hrv']). Unknown metrics return { present: false } for that entry, never an error.",
        ),
      window: coachScopeWindowSchema.optional(),
      cursor: z
        .string()
        .max(256)
        .optional()
        .describe(
          "Opaque pagination cursor from a previous response's nextCursor. Treat as a black box.",
        ),
    },
    annotations: READ_ONLY_ANNOTATIONS,
    outputShape: getMetricsOutput,
    async run(ctx, args) {
      const requested = Array.isArray(args.metrics)
        ? args.metrics
            .filter((m): m is string => typeof m === "string")
            .map((m) => m.trim())
            .filter((m) => m.length > 0)
            .slice(0, MAX_METRICS_PER_CALL)
        : [];
      const window = typeof args.window === "string" ? args.window : undefined;

      const offset = decodeOffsetCursor(args.cursor);
      const page = requested.slice(offset, offset + METRICS_PAGE_SIZE);
      const hasMore = offset + METRICS_PAGE_SIZE < requested.length;

      // Fan out over the SAME single-metric read; the executor validates each
      // metric and returns a grounded `{ present, … }` (never throws), so one
      // unknown metric cannot break the batch.
      const results = await Promise.all(
        page.map(async (metric) => {
          const r = (await executeCoachTool({
            userId: ctx.userId,
            name: "get_metric_series",
            rawArguments: JSON.stringify({
              metric,
              ...(window ? { window } : {}),
            }),
          })) as {
            present: boolean;
            reason?: string;
            data?: unknown;
            grounding?: string;
          };
          return {
            metric,
            present: r.present,
            ...(r.reason ? { reason: r.reason } : {}),
            ...(r.data !== undefined ? { data: r.data } : {}),
            ...(r.grounding ? { grounding: r.grounding } : {}),
          };
        }),
      );

      annotate({
        action: { name: "mcp.tool.invoked" },
        meta: {
          tool: "get_metrics",
          present: results.some((r) => r.present),
        },
      });
      return {
        present: results.some((r) => r.present),
        ...(window ? { window } : {}),
        results,
        ...(hasMore
          ? { nextCursor: encodeOffsetCursor(offset + METRICS_PAGE_SIZE) }
          : {}),
      };
    },
  },
  ...searchAndFetchTools(),
];

/** Stable list of the registered tool names. */
export const MCP_TOOL_NAMES: readonly string[] = MCP_TOOLS.map((t) => t.name);
