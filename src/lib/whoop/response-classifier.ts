/**
 * Off-response classifier for WHOOP API replies.
 *
 * Mirrors the Withings classifier (`src/lib/withings/response-classifier.ts`)
 * but speaks the WHOOP wire instead. WHOOP, unlike Withings, signals failure
 * through the HTTP status code itself (no `status` field embedded in a 200
 * body), so this classifier is HTTP-status-driven.
 *
 * Classification buckets:
 *
 *   - `success`         → HTTP 2xx
 *   - `transient`       → retryable: HTTP 429 (rate-limited — WHOOP caps at
 *                         100 req/min + 10 000 req/day per app), 5xx upstream
 *                         outages, 3xx CDN/network glitches, and an empty /
 *                         off-spec body where we never reached the envelope.
 *   - `reauth_required` → HTTP 401 / 403 — the access token is rejected or the
 *                         grant was revoked; the user must redo OAuth.
 *   - `persistent`      → any other 4xx (400, 404, 422, …) — a malformed
 *                         request or a contract mismatch that retrying without
 *                         operator intervention will not fix.
 *
 * The classifier is conservative: anything it doesn't recognise defaults to
 * `transient` so a single unknown response doesn't hard-disable the
 * integration. The 3-strike admin-alert ladder in `recordSyncFailure`
 * already catches the "keeps happening" case for recurring transients.
 */

/** Outcome buckets for a WHOOP response. Same shape as Withings. */
export type WhoopClassification =
  | "success"
  | "transient"
  | "reauth_required"
  | "persistent";

export interface ClassifiedWhoopResponse {
  classification: WhoopClassification;
  /** The HTTP status code that drove the verdict (undefined if none seen). */
  httpStatus: number | undefined;
  /** Short human-readable label for logs / audit details. */
  reason: string;
}

/**
 * Classify a single WHOOP API response by its HTTP status code.
 *
 * @param httpStatus  The HTTP status from fetch.
 */
export function classifyWhoopResponse(
  httpStatus: number,
): ClassifiedWhoopResponse {
  if (httpStatus >= 200 && httpStatus < 300) {
    return { classification: "success", httpStatus, reason: "ok" };
  }
  // 429 is rate-limit — honour `X-RateLimit-*` for backoff at the call site,
  // but the verdict is a plain transient so the next sync retries.
  if (httpStatus === 429) {
    return { classification: "transient", httpStatus, reason: "http_429" };
  }
  // 401/403 — the bearer token is rejected or the grant revoked. The user has
  // to reconnect; do not retry silently.
  if (httpStatus === 401 || httpStatus === 403) {
    return {
      classification: "reauth_required",
      httpStatus,
      reason: `http_${httpStatus}`,
    };
  }
  // Any other 4xx is a malformed request / contract mismatch — persistent.
  if (httpStatus >= 400 && httpStatus < 500) {
    return {
      classification: "persistent",
      httpStatus,
      reason: `http_${httpStatus}`,
    };
  }
  // 5xx upstream outage — retryable.
  if (httpStatus >= 500 && httpStatus < 600) {
    return {
      classification: "transient",
      httpStatus,
      reason: `http_${httpStatus}`,
    };
  }
  // 3xx (a CDN / redirect glitch — safeFetch uses redirect:"manual", so a
  // surfaced 3xx is unexpected) and everything else defaults to transient.
  return {
    classification: "transient",
    httpStatus,
    reason: `http_${httpStatus}_unknown`,
  };
}

/**
 * Typed Error subclass carrying the classification verdict so downstream
 * `try/catch` blocks can branch without re-parsing the message. Mirrors
 * `WithingsApiError`.
 */
export class WhoopApiError extends Error {
  readonly classification: WhoopClassification;
  readonly httpStatus: number | undefined;
  readonly reason: string;
  readonly verb: string;

  constructor(opts: {
    verb: string;
    classification: WhoopClassification;
    httpStatus: number | undefined;
    reason: string;
    upstreamError?: string;
  }) {
    const statusLabel =
      typeof opts.httpStatus === "number" ? opts.httpStatus : "?";
    const errSegment = opts.upstreamError ? ` - ${opts.upstreamError}` : "";
    // Cap the message at 1024 chars in the constructor (same bound as
    // WithingsApiError) so a misbehaving upstream returning a multi-MB error
    // body can't bloat an AuditLog row downstream.
    const raw = `WHOOP ${opts.verb} error: ${statusLabel}${errSegment}`;
    super(raw.slice(0, 1024));
    this.name = "WhoopApiError";
    this.verb = opts.verb;
    this.classification = opts.classification;
    this.httpStatus = opts.httpStatus;
    this.reason = opts.reason;
  }
}

/**
 * Read the classification from any caught error. Returns `transient` for a
 * non-`WhoopApiError` input so a call site surfacing a plain `Error` retries
 * rather than permanently disabling the integration. Falls back to parsing the
 * HTTP status out of the legacy `"WHOOP <verb> error: <status>"` message shape
 * for callers that lose the original prototype across a pg-boss retry.
 */
export function classifyWhoopError(err: unknown): WhoopClassification {
  if (err instanceof WhoopApiError) return err.classification;

  const msg = err instanceof Error ? err.message : String(err);
  const m = /WHOOP\s+\w+\s+error:\s*(\d+)/.exec(msg);
  if (!m) return "transient";
  const status = Number.parseInt(m[1]!, 10);
  if (!Number.isFinite(status)) return "transient";
  return classifyWhoopResponse(status).classification;
}
