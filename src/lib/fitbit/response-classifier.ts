/**
 * Off-response classifier for Fitbit / Google Health API replies (v1.12.0).
 *
 * Mirrors the WHOOP classifier (`src/lib/whoop/response-classifier.ts`) but
 * speaks the Google Health wire. Like WHOOP, Google signals failure through the
 * HTTP status code itself (no `status` field embedded in a 200 body), so this
 * classifier is HTTP-status-driven.
 *
 * Classification buckets:
 *
 *   - `success`         → HTTP 2xx
 *   - `transient`       → retryable: HTTP 429 (rate-limited — honour
 *                         `Retry-After` for backoff at the call site), 5xx
 *                         upstream outages, 3xx CDN/network glitches, and an
 *                         empty / off-spec body where we never reached the
 *                         envelope.
 *   - `reauth_required` → HTTP 401 / 403 — the access token is rejected or the
 *                         grant was revoked; the user must redo OAuth. (The
 *                         per-data-class 403 soft-skip lives in `sync.ts`'s
 *                         `isCollectionForbidden`, not here, so a Restricted
 *                         scope granted independently doesn't park the whole
 *                         connection.)
 *   - `persistent`      → any other 4xx (400, 404, 422, …) — a malformed
 *                         request or a contract mismatch that retrying without
 *                         operator intervention will not fix.
 *
 * The classifier is conservative: anything it doesn't recognise defaults to
 * `transient` so a single unknown response doesn't hard-disable the
 * integration. The 3-strike admin-alert ladder in `recordSyncFailure` already
 * catches the "keeps happening" case for recurring transients.
 *
 * Unlike WHOOP, there is no `invalid_grant` token-body special-case: Google
 * signals a revoked refresh token with a 401 on the token endpoint, which the
 * status-driven classifier already buckets as `reauth_required`.
 */

/** Outcome buckets for a Fitbit response. Same shape as WHOOP. */
export type FitbitClassification =
  | "success"
  | "transient"
  | "reauth_required"
  | "persistent";

export interface ClassifiedFitbitResponse {
  classification: FitbitClassification;
  /** The HTTP status code that drove the verdict (undefined if none seen). */
  httpStatus: number | undefined;
  /** Short human-readable label for logs / audit details. */
  reason: string;
}

/**
 * Classify a single Fitbit / Google Health API response by its HTTP status.
 *
 * @param httpStatus  The HTTP status from fetch.
 */
export function classifyFitbitResponse(
  httpStatus: number,
): ClassifiedFitbitResponse {
  if (httpStatus >= 200 && httpStatus < 300) {
    return { classification: "success", httpStatus, reason: "ok" };
  }
  // 429 is rate-limit — honour `Retry-After` for backoff at the call site, but
  // the verdict is a plain transient so the next sync retries.
  if (httpStatus === 429) {
    return { classification: "transient", httpStatus, reason: "http_429" };
  }
  // 401/403 — the bearer token is rejected or the grant revoked. The user has
  // to reconnect; do not retry silently. (A per-data-class 403 soft-skip is
  // applied in sync.ts before this verdict drives a connection-wide reauth.)
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
 * `WhoopApiError`.
 */
export class FitbitApiError extends Error {
  readonly classification: FitbitClassification;
  readonly httpStatus: number | undefined;
  readonly reason: string;
  readonly verb: string;
  /**
   * The OAuth `error` code from a token-endpoint failure body (e.g.
   * `invalid_grant`). Captured for the audit trail; the classifier does not
   * branch on it (Google signals a revoked grant with a 401 status).
   */
  readonly upstreamError: string | undefined;

  constructor(opts: {
    verb: string;
    classification: FitbitClassification;
    httpStatus: number | undefined;
    reason: string;
    upstreamError?: string;
  }) {
    const statusLabel =
      typeof opts.httpStatus === "number" ? opts.httpStatus : "?";
    const errSegment = opts.upstreamError ? ` - ${opts.upstreamError}` : "";
    // Cap the message at 1024 chars in the constructor (same bound as
    // WhoopApiError) so a misbehaving upstream returning a multi-MB error body
    // can't bloat an AuditLog row downstream.
    const raw = `Fitbit ${opts.verb} error: ${statusLabel}${errSegment}`;
    super(raw.slice(0, 1024));
    this.name = "FitbitApiError";
    this.verb = opts.verb;
    this.classification = opts.classification;
    this.httpStatus = opts.httpStatus;
    this.reason = opts.reason;
    this.upstreamError = opts.upstreamError;
  }
}

/**
 * Read the classification from any caught error. Returns `transient` for a
 * non-`FitbitApiError` input so a call site surfacing a plain `Error` retries
 * rather than permanently disabling the integration. Falls back to parsing the
 * HTTP status out of the legacy `"Fitbit <verb> error: <status>"` message shape
 * for callers that lose the original prototype across a pg-boss retry.
 */
export function classifyFitbitError(err: unknown): FitbitClassification {
  if (err instanceof FitbitApiError) return err.classification;

  const msg = err instanceof Error ? err.message : String(err);
  const m = /Fitbit\s+\w+\s+error:\s*(\d+)/.exec(msg);
  if (!m) return "transient";
  const status = Number.parseInt(m[1]!, 10);
  if (!Number.isFinite(status)) return "transient";
  return classifyFitbitResponse(status).classification;
}
