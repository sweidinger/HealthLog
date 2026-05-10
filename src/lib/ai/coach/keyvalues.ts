/**
 * v1.4.22 — Coach evidence-block (`---KEYVALUES---` … `---END---`)
 * parser.
 *
 * The Coach prompt instructs the model to append, after its prose
 * reply, a sentinel block carrying the load-bearing numbers it cited:
 *
 *   ---KEYVALUES---
 *   avg30 systolic: 138 [mmHg] (last30days)
 *   Tue 6 May: 142/88 [mmHg]
 *   ---END---
 *
 * This module strips that block out of the streamed prose and parses
 * each line into a `CoachKeyValue`. The result feeds the
 * `provenance.keyValues` field that the UI renders as a collapsible
 * disclosure.
 *
 * Defence-in-depth:
 *   - Hard cap 1 KB on the sentinel block (prompt-injection guard).
 *   - Hard cap 8 lines kept (per the prompt contract).
 *   - Each line is validated against `coachKeyValueSchema`; malformed
 *     lines are dropped silently.
 *   - When the sentinel pair is malformed (e.g. no closing `---END---`,
 *     unbalanced sentinels), the parser returns the original prose
 *     untouched and emits no keyValues — the caller logs a wide-event
 *     `coach.keyvalues.parse_failed` for ops visibility.
 */
import { coachKeyValueSchema, type CoachKeyValue } from "./types";

/** Sentinel block payload hard cap — 1 KB after the opening marker. */
const SENTINEL_BYTE_CAP = 1024;
/** Max key/value rows kept inside the block (prompt-contract value). */
const SENTINEL_LINE_CAP = 8;

const OPEN_SENTINEL = "---KEYVALUES---";
const CLOSE_SENTINEL = "---END---";

/**
 * Parse one body line of the form
 *   `<label>: <value> [<unit>] (<window>)`
 * into a `CoachKeyValue`. The unit + window are both optional; an
 * input missing either or both still parses cleanly. Returns `null`
 * when the line does not match the expected shape — the caller drops
 * the line rather than rejecting the whole block.
 */
export function parseKeyValueLine(line: string): CoachKeyValue | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // Find the first `:` — the label cannot itself contain `:`. The
  // remainder may carry the value, an optional `[unit]`, and an
  // optional `(window)`.
  const colon = trimmed.indexOf(":");
  if (colon < 1) return null;

  const label = trimmed.slice(0, colon).trim();
  let rest = trimmed.slice(colon + 1).trim();
  if (!label || !rest) return null;

  let unit: string | undefined;
  let window: string | undefined;

  // Extract (window) if present at the very end. We allow the unit
  // bracket to follow either the value or the window-paren — both
  // emit orders show up across English/German few-shot examples.
  const winMatch = rest.match(/\s*\(([^()]+)\)\s*$/);
  if (winMatch) {
    window = winMatch[1].trim();
    rest = rest.slice(0, winMatch.index).trim();
  }

  // Extract [unit] if present at the end (after the optional window
  // strip).
  const unitMatch = rest.match(/\s*\[([^[\]]+)\]\s*$/);
  if (unitMatch) {
    unit = unitMatch[1].trim();
    rest = rest.slice(0, unitMatch.index).trim();
  }

  const value = rest.trim();
  if (!value) return null;

  const parsed = coachKeyValueSchema.safeParse({
    label,
    value,
    ...(unit ? { unit } : {}),
    ...(window ? { window } : {}),
  });
  if (!parsed.success) return null;
  return parsed.data;
}

export interface SentinelParseResult {
  /** Prose with the sentinel block (if any) stripped out. */
  prose: string;
  /** Parsed key/value rows. Empty when no valid sentinel was found. */
  keyValues: CoachKeyValue[];
  /**
   * `true` when the parser saw an opening `---KEYVALUES---` marker
   * but failed to extract a complete + non-empty + well-formed block.
   * Callers log this for ops visibility (graceful degrade).
   */
  malformed: boolean;
}

/**
 * Split a raw assistant reply into `{ prose, keyValues }`.
 *
 * The streamed prose passed to the client is the `prose` field — the
 * `---KEYVALUES---` block is stripped before any token frame is sent
 * so the user never sees the raw sentinel.
 */
export function parseKeyValuesSentinel(raw: string): SentinelParseResult {
  if (!raw) {
    return { prose: "", keyValues: [], malformed: false };
  }

  const openIdx = raw.indexOf(OPEN_SENTINEL);
  if (openIdx === -1) {
    return { prose: raw, keyValues: [], malformed: false };
  }

  // Everything before the opening marker is prose; trim trailing
  // whitespace introduced by the marker's own leading newline so the
  // bubble doesn't render an extra blank paragraph.
  const prose = raw.slice(0, openIdx).replace(/\s+$/u, "");

  const afterOpen = raw.slice(openIdx + OPEN_SENTINEL.length);
  // Look for the closing sentinel; if missing, the block is
  // malformed — fall back to the original prose and emit nothing.
  const closeRel = afterOpen.indexOf(CLOSE_SENTINEL);
  let bodyRaw: string;
  let malformedClose = false;
  if (closeRel === -1) {
    // Treat the rest of the reply as the block body so we can still
    // parse what's there — but flag malformed so the caller knows
    // the contract wasn't fully met.
    bodyRaw = afterOpen;
    malformedClose = true;
  } else {
    bodyRaw = afterOpen.slice(0, closeRel);
  }

  // Defence-in-depth: cap the sentinel payload at 1 KB before we
  // bother parsing. An adversarial reply could otherwise pad the
  // block with megabytes of garbage.
  let body = bodyRaw;
  let truncated = false;
  if (body.length > SENTINEL_BYTE_CAP) {
    body = body.slice(0, SENTINEL_BYTE_CAP);
    truncated = true;
  }

  const lines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    // Skip any stray opening / closing markers that landed inside the
    // body (rare but cheap to ignore).
    .filter((l) => l !== OPEN_SENTINEL && l !== CLOSE_SENTINEL);

  const kept: CoachKeyValue[] = [];
  for (const line of lines) {
    if (kept.length >= SENTINEL_LINE_CAP) break;
    const entry = parseKeyValueLine(line);
    if (entry) kept.push(entry);
  }

  // Malformed when:
  //   - closing sentinel missing, OR
  //   - block payload was truncated to fit the 1 KB cap, OR
  //   - the block was present but yielded zero valid rows.
  const malformed = malformedClose || truncated || kept.length === 0;

  return {
    prose,
    keyValues: kept,
    malformed,
  };
}
