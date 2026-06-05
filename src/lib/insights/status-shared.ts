/**
 * Shared helpers for the seven per-card status generators.
 *
 * Every `src/lib/insights/*-status.ts` generator carried byte-identical
 * copies of `round`, `normalizeSummaryText`, `normalizeLocale`, and (in
 * six of seven) `summarizeSeries`, plus an identical "parse the model's
 * `{summary}` envelope" block and an identical `prisma.auditLog.create`
 * persist block. This module is the single source of truth so a change
 * to the rounding precision, the chart-token scrub, or the cache-row
 * shape lands once rather than seven times.
 *
 * The shapes are intentionally narrow — `SupportedLocale` is `de | en`
 * because the status prompts ship only those two locales. The
 * medication-compliance generator writes a richer cache `details` shape
 * (it carries a per-medication array), so it shares `round`,
 * `normalizeSummaryText`, `normalizeLocale`, and `parseSummaryFromContent`
 * but keeps its own `auditLog.create`.
 */
import { prisma } from "@/lib/db";
import { stripChartTokens } from "@/lib/insights/chart-tokens";

export type SupportedLocale = "de" | "en";

/** Round to `digits` decimal places. */
export function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Scrub chart tokens and collapse whitespace out of a model summary. */
export function normalizeSummaryText(value: string): string {
  return stripChartTokens(value).replace(/\s+/g, " ").trim();
}

/** Narrow an arbitrary locale string to the two the prompts support. */
export function normalizeLocale(
  value: string | null | undefined,
): SupportedLocale {
  return value === "en" ? "en" : "de";
}

export interface SeriesSummary {
  points: number;
  start: number;
  end: number;
  delta: number;
  mean: number;
  min: number;
  max: number;
}

/**
 * Fold a value series into a single start/end/delta/mean/min/max
 * summary. Returns null for an empty series.
 *
 * v1.4.33 — fold sum/min/max into a single walk. The previous
 * `Math.min(...series.map(...))` / `Math.max(...series.map(...))`
 * spread tripped V8's ~125 000-arg ceiling on the bound /api/analytics
 * path; see `.planning/round-v1433-analytics-500-report.md` §"Carry-
 * over". These helpers are fed bounded windows today so the crash
 * never reached them, but the spread allocates a transient args array
 * on every call — the fold is both stack-safe and cheaper.
 */
export function summarizeSeries(
  series: Array<{ value: number }>,
): SeriesSummary | null {
  if (series.length === 0) return null;
  const first = series[0].value;
  const last = series[series.length - 1].value;
  let sum = 0;
  let minVal = series[0].value;
  let maxVal = series[0].value;
  for (const entry of series) {
    sum += entry.value;
    if (entry.value < minVal) minVal = entry.value;
    if (entry.value > maxVal) maxVal = entry.value;
  }
  return {
    points: series.length,
    start: round(first, 2),
    end: round(last, 2),
    delta: round(last - first, 2),
    mean: round(sum / series.length, 2),
    min: round(minVal, 2),
    max: round(maxVal, 2),
  };
}

/**
 * Strip a Markdown code fence and isolate the JSON object body.
 *
 * The Anthropic and local providers have no native JSON mode (only the
 * OpenAI-family clients send `response_format: json_object`), so a
 * compliant model still routinely wraps its `{ "summary": … }` reply in a
 * ```json … ``` fence or prefixes it with a sentence. `JSON.parse` then
 * throws and the caller would surface the raw fenced string as the
 * user-facing assessment. This helper removes a leading/trailing fence and
 * narrows to the first `{` … last `}` span so the parse sees clean JSON.
 *
 * It is a no-op on already-clean JSON and on genuinely fence-free prose
 * with no braces — in both cases the original (trimmed) string is returned,
 * so the bare-prose fallback below still works.
 */
export function stripJsonFences(content: string): string {
  let text = content.trim();
  // Drop a leading ```json / ``` fence and a trailing ``` fence if present.
  const fenced = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  if (fenced) {
    text = fenced[1].trim();
  }
  // Narrow to the first `{` … last `}` so a leading/trailing sentence the
  // model added around the object does not break the parse.
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    return text.slice(first, last + 1);
  }
  return text;
}

/**
 * Pull the `summary` string out of a model completion. The status
 * prompts return a `{ "summary": "…" }` envelope; a model that ignores
 * the contract and returns bare prose falls back to the raw content.
 *
 * Tries the content as-is first (the common, fence-free case), then a
 * fence-stripped retry for providers without a native JSON mode.
 */
export function parseSummaryFromContent(content: string): string {
  try {
    const parsed = JSON.parse(content) as { summary?: string };
    if (typeof parsed.summary === "string") return parsed.summary;
  } catch {
    // not directly parseable — try a fence-stripped retry below
  }
  try {
    const stripped = stripJsonFences(content);
    if (stripped !== content) {
      const parsed = JSON.parse(stripped) as { summary?: string };
      if (typeof parsed.summary === "string") return parsed.summary;
    }
  } catch {
    // still not JSON — fall through to the raw content
  }
  return content;
}

/**
 * Persist one status assessment cache row in the standard text-only
 * shape (`{ dateKey, locale, text, providerType, model, tokensUsed }`).
 * Returns the row's `createdAt` ISO string. The medication-compliance
 * generator writes a richer `details` shape (per-medication array) and
 * keeps its own `auditLog.create` call.
 */
export async function persistStatusInsight(args: {
  userId: string;
  cacheAction: string;
  todayKey: string;
  locale: SupportedLocale;
  text: string;
  providerType: string;
  model: string;
  tokensUsed: number | null;
}): Promise<string> {
  const created = await prisma.auditLog.create({
    data: {
      userId: args.userId,
      action: args.cacheAction,
      details: JSON.stringify({
        dateKey: args.todayKey,
        locale: args.locale,
        text: args.text,
        providerType: args.providerType,
        model: args.model,
        tokensUsed: args.tokensUsed,
      }),
    },
    select: { createdAt: true },
  });
  return created.createdAt.toISOString();
}
