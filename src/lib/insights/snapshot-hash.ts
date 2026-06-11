/**
 * v1.16.8 — content hash over the data snapshot that feeds an insight
 * generation.
 *
 * Every insight generator (the comprehensive briefing, the seven
 * specialised status cards, the generic metric cards) builds a compacted
 * data snapshot and embeds it in the prompt. Before this hash existed,
 * every nightly tick, forced warm, and ingest-driven regeneration ran the
 * full LLM round-trip even when that snapshot was byte-identical to the
 * one the cached text was generated from — a same-data regeneration that
 * produced a near-identical paragraph at full provider cost, dozens of
 * times per user per day.
 *
 * `hashInsightSnapshot` turns the snapshot into a deterministic SHA-256
 * fingerprint. Callers store it alongside the cached text and skip the
 * provider call whenever the stored hash matches the fresh snapshot's
 * hash (refreshing only the cache timestamp). The fingerprint covers the
 * data the prompt actually sees, with two deliberate exclusions:
 *
 *   - `locale` + day labels (`generatedForDay`, `dateKey`, `todayKey`):
 *     the underlying data is locale-independent and the calendar label
 *     changes at midnight without any data change. Excluding them keeps
 *     the gate locale-agnostic and stable across the day rollover.
 *   - clock-relative offsets (`dayOffset`, keys ending in `DaysAgo`):
 *     these shift with `now`, not with the data. The bucket VALUES (and
 *     the absolute `date` / `weekISO` / `month` keys the graded series
 *     carry) stay in the hash, so a genuinely new or changed reading
 *     still changes the fingerprint. Sliding windows still move at the
 *     Berlin day boundary, so an active account converges to roughly one
 *     content change per scope per day — which is the regeneration
 *     budget the gate is meant to enforce.
 *
 * Serialisation is canonical: object keys are sorted, arrays keep their
 * order, `Date` collapses to ISO-8601, `undefined` members are dropped
 * (matching `JSON.stringify`). Two snapshots that would render the same
 * prompt data therefore always hash equal, regardless of property
 * insertion order.
 */
import { createHash } from "crypto";

/** Keys excluded from the fingerprint — see the module doc for why. */
const VOLATILE_KEYS = new Set([
  "locale",
  "generatedForDay",
  "dateKey",
  "todayKey",
  "dayOffset",
]);

function isVolatileKey(key: string): boolean {
  return VOLATILE_KEYS.has(key) || key.endsWith("DaysAgo");
}

/** Canonical, key-sorted serialisation with volatile keys dropped. */
function canonicalise(value: unknown): string {
  if (value === null) return "null";
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) {
    return `[${value
      .map((entry) => canonicalise(entry === undefined ? null : entry))
      .join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key, v]) => v !== undefined && !isVolatileKey(key))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, v]) => `${JSON.stringify(key)}:${canonicalise(v)}`);
    return `{${entries.join(",")}}`;
  }
  // string | number | boolean — JSON.stringify is canonical for these.
  // (undefined / function / symbol never appear in the JSON-ready
  // snapshots; a top-level undefined canonicalises like JSON's null.)
  return JSON.stringify(value) ?? "null";
}

/**
 * SHA-256 hex fingerprint of an insight data snapshot. Deterministic
 * across key order, locale, and intra-day clock drift; changes whenever
 * a value the prompt actually narrates changes.
 */
export function hashInsightSnapshot(value: unknown): string {
  return createHash("sha256").update(canonicalise(value)).digest("hex");
}
