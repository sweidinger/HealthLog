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
} from "@/lib/mcp/rich-reads";
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
        "Search the user's own health record — metric domains, medications, and lab biomarkers — for items matching a free-text query. Returns a list of { id, title, url }; pass an id to the `fetch` tool to hydrate it. Each `url` deep-links into the HealthLog web app for citation. Returns an empty list when nothing matches.",
      inputShape: { query: z.string().max(200) },
      annotations: READ_ONLY_ANNOTATIONS,
      outputShape: {
        results: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            url: z.string(),
          }),
        ),
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

        const capped = results.slice(0, 50);
        annotate({
          action: { name: "mcp.tool.invoked" },
          meta: { tool: "search", present: capped.length > 0 },
        });
        return { results: capped };
      },
    },
    {
      name: "fetch",
      title: "Fetch one health record",
      description:
        "Hydrate a single record returned by `search`, by its id (e.g. `metric:weight`, `med:<id>`, `lab:LDL`). Returns { id, title, text, url, metadata } where `text` is a server-authoritative, plain-text summary suitable for citation and `url` deep-links into HealthLog. Returns a not-found message when the id does not resolve.",
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
            text: JSON.stringify(result),
            url: `${origin}/insights`,
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
            text: JSON.stringify(result),
            url: `${origin}/labs`,
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
          return {
            id,
            title: med.name,
            text: JSON.stringify(med),
            url: `${origin}/medications`,
            metadata: { type: "medication" },
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

// ── Phase 4 deep-value output schemas ────────────────────────────────
// Every field except `present` is optional so a grounded `{ present: false }`
// miss and a full hit both conform — the SDK validates `structuredContent`
// against these (REQ: structuredContent + outputSchema on the rich reads).

const bandShape = z
  .object({ low: z.number(), high: z.number() })
  .nullable()
  .optional();

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
});

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
    run(ctx, args) {
      return runCoachTool(ctx, "get_medication_compliance", args);
    },
  },
  {
    name: "get_labs",
    title: "Get lab results",
    description:
      "Fetch the user's most recent lab results — the latest reading per biomarker over the last 12 months, optionally filtered to one named analyte. Each reading carries its value, unit, reference range, and in-range/below/above status. Returns { present: false } when no labs are on file.",
    inputShape: {
      analyte: z.string().min(1).max(80).optional(),
    },
    annotations: READ_ONLY_ANNOTATIONS,
    run(ctx, args) {
      return runCoachTool(ctx, "get_labs", args);
    },
  },
  {
    name: "get_correlations",
    title: "Get discovered correlations",
    description:
      "Fetch the user's statistically-vetted (FDR-controlled) day-to-next-day driver pairs between behaviours (daylight, mood, glucose, blood pressure, steps) and outcomes (sleep, HRV, resting HR, weight), each with direction, lag, sample size, and a descriptive — never causal — note over a fixed trailing window. Returns { present: false } when too little paired data exists.",
    inputShape: {},
    annotations: READ_ONLY_ANNOTATIONS,
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
      "Compare one metric against another over the same trailing window, OR a single metric across two trailing windows (e.g. last 30 days vs last 90 days). Returns each side's rollup statistics (count, mean, min, max) with units and reference bands, plus a delta + percent change when both sides share a unit. Windows are trailing-to-now. Returns { present: false } when a side has no data.",
    inputShape: {
      metric: z.string().min(1).max(60),
      metricB: z.string().min(1).max(60).optional(),
      window: coachScopeWindowSchema.optional(),
      windowB: coachScopeWindowSchema.optional(),
    },
    annotations: READ_ONLY_ANNOTATIONS,
    outputShape: compareMetricOutput,
    run(ctx, args) {
      return compareMetric(ctx.userId, {
        metric: String(args.metric ?? ""),
        metricB: typeof args.metricB === "string" ? args.metricB : undefined,
        window: args.window as never,
        windowB: args.windowB as never,
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
      "Surface points where a metric's level shifted over a trailing window (e.g. 'when did my weight trend change?'). Runs a conservative changepoint scan over the rollup tier's bucket means and reports each shift's date, direction, and before/after means with units. High firing bar — returns { present: false } when too little data exists or no shift clears the threshold.",
    inputShape: {
      metric: z.string().min(1).max(60),
      window: coachScopeWindowSchema.optional(),
    },
    annotations: READ_ONLY_ANNOTATIONS,
    outputShape: detectChangepointsOutput,
    run(ctx, args) {
      return detectChangepoints(ctx.userId, {
        metric: String(args.metric ?? ""),
        window: args.window as never,
      });
    },
  },
  ...searchAndFetchTools(),
];

/** Stable list of the registered tool names. */
export const MCP_TOOL_NAMES: readonly string[] = MCP_TOOLS.map((t) => t.name);
