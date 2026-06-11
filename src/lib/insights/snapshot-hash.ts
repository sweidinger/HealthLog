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
 *   - clock-relative offsets (`dayOffset`): these shift with `now`, not
 *     with the data. The bucket VALUES (and the absolute `date` /
 *     `weekISO` / `month` keys the graded series carry) stay in the
 *     hash, so a genuinely new or changed reading still changes the
 *     fingerprint. Sliding windows still move at the Berlin day
 *     boundary, so an active account converges to roughly one content
 *     change per scope per day — which is the regeneration budget the
 *     gate is meant to enforce.
 *
 * Keys ending in `DaysAgo` (`newestMeasurementDaysAgo`, the per-series
 * `newestDaysAgo` / `oldestDaysAgo`, the signal block's recency) get a
 * third treatment: they are hashed as a coarse STALENESS TIER, not as the
 * raw day count and not excluded. The raw number shifts with `now` every
 * midnight, but the prompt's staleness caveat ("values may be out of
 * date" past ~7 days) is driven by exactly these keys — excluding them
 * wholesale meant an account that stopped logging kept an unchanged
 * fingerprint forever, so the daily refresh re-stamped a text that
 * narrated week-old readings as current. Bucketing keeps the fingerprint
 * stable across ordinary day rollovers within a tier and flips it
 * precisely when the data crosses a staleness boundary — i.e. when the
 * narrative should change.
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
  return VOLATILE_KEYS.has(key);
}

/**
 * Staleness tiers for `*DaysAgo` keys. The boundaries follow the prompt
 * contract: 0-1 days is "current" (the prompts phrase today / 1 day ago
 * specially), 2-7 days is recent (no caveat yet — the data-strength line
 * flags staleness strictly past 7 days), 8-30 days carries the
 * "values may be out of date" caveat, and past 30 days the picture is
 * long stale. Crossing a boundary flips the fingerprint so the cached
 * text regenerates with the right framing; movement within a tier keeps
 * it stable so an ordinary midnight rollover stays free.
 */
export type StalenessTier = "0-1d" | "2-7d" | "8-30d" | "30d+";

/**
 * Map a days-ago count to its staleness tier. Pure integer bucketing —
 * the caller computed the day count, so no clock and no timezone enter
 * here and the tier is stable wherever the hash is computed.
 */
export function stalenessTier(daysAgo: number): StalenessTier {
  if (daysAgo <= 1) return "0-1d";
  if (daysAgo <= 7) return "2-7d";
  if (daysAgo <= 30) return "8-30d";
  return "30d+";
}

/** True for the day-count recency keys that hash as a staleness tier. */
function isStalenessKey(key: string): boolean {
  return key.endsWith("DaysAgo");
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
      .map(([key, v]) => {
        // A days-ago recency hashes as its coarse tier (see module doc);
        // a null / non-numeric value falls through to plain canonical
        // form so "no dated reading" stays distinct from every tier.
        const canonical =
          isStalenessKey(key) && typeof v === "number" && Number.isFinite(v)
            ? JSON.stringify(stalenessTier(v))
            : canonicalise(v);
        return `${JSON.stringify(key)}:${canonical}`;
      });
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
