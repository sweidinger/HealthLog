/**
 * Per-process in-memory ring buffer for the most recent wide events.
 *
 * Used by `/admin/app-logs` so admins can drill into structured wide-events
 * without standing up a Loki stack just to read the last hour of traffic.
 * Events are pushed by `transports.emitEvent()` after they pass the sampler
 * gate (so the buffer mirrors what a Loki sink would receive, not the raw
 * pre-sampling firehose).
 *
 * Limitations:
 *   - Per-process. Under `HEALTHLOG_PROCESS_TYPE=web,worker` split, the
 *     web buffer doesn't see worker events and vice-versa. The UI surfaces
 *     this caveat in the section header.
 *   - 500-entry cap (~500KB max @ ~1KB/event). FIFO eviction on overflow.
 *   - Volatile — restart drops the buffer. For durable storage configure
 *     `LOKI_ENDPOINT` and tail Loki instead.
 *
 * Privacy: events stored raw. The API render path (`/api/admin/app-logs`)
 * runs `redactSecrets()` on egress so a stray Bearer token in an error
 * message never leaks to the admin UI.
 */
import type { WideEvent, LogLevel } from "./types";

export const LOG_BUFFER_MAX = 500;

// Plain array with FIFO eviction. A linked list would be technically tighter
// but for 500 entries the array shift overhead (~microseconds) is invisible
// next to the rest of the request lifecycle.
let buffer: WideEvent[] = [];

/** Append an event to the buffer; evict the oldest entry once cap is hit. */
export function appendLogEvent(event: WideEvent): void {
  buffer.push(event);
  if (buffer.length > LOG_BUFFER_MAX) {
    buffer.shift();
  }
}

export interface ReadLogBufferOptions {
  /** Exact match on `event.trace_id`. */
  traceId?: string;
  /** Exact match on `event.level`. */
  level?: LogLevel;
  /** Case-insensitive substring match on `event.action.name`. */
  action?: string;
  /** Inclusive lower bound on `event.timestamp`. */
  since?: Date;
  /** Inclusive upper bound on `event.timestamp`. */
  until?: Date;
  /** Cap the number of returned entries. */
  limit?: number;
}

/**
 * Read the buffer with optional filters. Results are returned newest-first
 * (descending by insertion order, which matches `event.timestamp` since we
 * push at request-finish time).
 */
export function readLogBuffer(opts: ReadLogBufferOptions): WideEvent[] {
  const sinceMs = opts.since?.getTime();
  const untilMs = opts.until?.getTime();
  const actionLower = opts.action?.toLowerCase();

  // Walk back-to-front so the result is newest-first without an extra reverse.
  const out: WideEvent[] = [];
  for (let i = buffer.length - 1; i >= 0; i--) {
    const event = buffer[i];
    if (opts.traceId && event.trace_id !== opts.traceId) continue;
    if (opts.level && event.level !== opts.level) continue;
    if (actionLower) {
      const name = event.action?.name?.toLowerCase() ?? "";
      if (!name.includes(actionLower)) continue;
    }
    if (sinceMs !== undefined || untilMs !== undefined) {
      const ts = Date.parse(event.timestamp);
      if (sinceMs !== undefined && ts < sinceMs) continue;
      if (untilMs !== undefined && ts > untilMs) continue;
    }
    out.push(event);
    if (opts.limit !== undefined && out.length >= opts.limit) break;
  }
  return out;
}

/** Reset the buffer (test-only — not exported from the package index). */
export function clearLogBuffer(): void {
  buffer = [];
}

/** Current buffer size (test-only). */
export function getLogBufferSize(): number {
  return buffer.length;
}
