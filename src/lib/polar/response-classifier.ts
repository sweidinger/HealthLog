/**
 * v1.17.0 (F4) — off-response classifier for Polar AccessLink replies.
 *
 * Mirrors the WHOOP classifier (`src/lib/whoop/response-classifier.ts`): Polar
 * signals failure through the HTTP status code, so the classifier is
 * status-driven.
 *
 *   - `success`         → HTTP 2xx (incl. 204 No Content — Polar returns 204
 *                         when a collection window holds no records).
 *   - `transient`       → retryable: 429 (rate-limited), 5xx upstream, 3xx
 *                         CDN glitch, and an unknown status.
 *   - `reauth_required` → 401 / 403 — the access token is rejected or the user
 *                         revoked the grant; the user must reconnect.
 *   - `persistent`      → any other 4xx — a malformed request / contract
 *                         mismatch that a retry won't fix.
 */

export type PolarClassification =
  | "success"
  | "transient"
  | "reauth_required"
  | "persistent";

export interface ClassifiedPolarResponse {
  classification: PolarClassification;
  httpStatus: number | undefined;
  reason: string;
}

export function classifyPolarResponse(
  httpStatus: number,
): ClassifiedPolarResponse {
  if (httpStatus >= 200 && httpStatus < 300) {
    return { classification: "success", httpStatus, reason: "ok" };
  }
  if (httpStatus === 429) {
    return { classification: "transient", httpStatus, reason: "http_429" };
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return {
      classification: "reauth_required",
      httpStatus,
      reason: `http_${httpStatus}`,
    };
  }
  if (httpStatus >= 400 && httpStatus < 500) {
    return {
      classification: "persistent",
      httpStatus,
      reason: `http_${httpStatus}`,
    };
  }
  if (httpStatus >= 500 && httpStatus < 600) {
    return {
      classification: "transient",
      httpStatus,
      reason: `http_${httpStatus}`,
    };
  }
  return {
    classification: "transient",
    httpStatus,
    reason: `http_${httpStatus}_unknown`,
  };
}

/** Typed error carrying the classification verdict. Mirrors `WhoopApiError`. */
export class PolarApiError extends Error {
  readonly classification: PolarClassification;
  readonly httpStatus: number | undefined;
  readonly reason: string;
  readonly verb: string;
  readonly upstreamError: string | undefined;

  constructor(opts: {
    verb: string;
    classification: PolarClassification;
    httpStatus: number | undefined;
    reason: string;
    upstreamError?: string;
  }) {
    const statusLabel =
      typeof opts.httpStatus === "number" ? opts.httpStatus : "?";
    const errSegment = opts.upstreamError ? ` - ${opts.upstreamError}` : "";
    const raw = `Polar ${opts.verb} error: ${statusLabel}${errSegment}`;
    super(raw.slice(0, 1024));
    this.name = "PolarApiError";
    this.verb = opts.verb;
    this.classification = opts.classification;
    this.httpStatus = opts.httpStatus;
    this.reason = opts.reason;
    this.upstreamError = opts.upstreamError;
  }
}

/**
 * Read the classification from any caught error. A non-`PolarApiError` defaults
 * to `transient` so a plain `Error` retries rather than disabling the
 * integration. Falls back to parsing the status out of the message shape for a
 * caller that lost the prototype across a pg-boss retry.
 */
export function classifyPolarError(err: unknown): PolarClassification {
  if (err instanceof PolarApiError) return err.classification;
  const msg = err instanceof Error ? err.message : String(err);
  const m = /Polar\s+\w+\s+error:\s*(\d+)/.exec(msg);
  if (!m) return "transient";
  const status = Number.parseInt(m[1]!, 10);
  if (!Number.isFinite(status)) return "transient";
  return classifyPolarResponse(status).classification;
}
