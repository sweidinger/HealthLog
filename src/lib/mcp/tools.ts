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

import { annotate } from "@/lib/logging/context";
import { executeCoachTool } from "@/lib/ai/coach/tools/executor";
import { buildCoachDataInventory } from "@/lib/ai/coach/tools/inventory";
import {
  coachScopeSourceSchema,
  coachScopeWindowSchema,
} from "@/lib/ai/coach/types";
import type { McpAuthContext } from "./auth";

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

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "list_metrics",
    title: "List available metrics",
    description:
      "Enumerate which of the user's health data exists and how to fetch it: one row per domain with whether data is present, an approximate sample count, and the tool that retrieves it. Call this first to discover what is available before fetching figures.",
    inputShape: {},
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
    run(ctx, args) {
      return runCoachTool(ctx, "get_correlations", args);
    },
  },
];

/** Stable list of the registered tool names. */
export const MCP_TOOL_NAMES: readonly string[] = MCP_TOOLS.map((t) => t.name);
