/**
 * v1.17.0 (F4) — off-response classifier for Oura Cloud API v2 replies.
 * Mirrors the WHOOP / Polar classifiers: HTTP-status-driven.
 *
 *   - `success`         → HTTP 2xx
 *   - `transient`       → 429 (rate-limited), 5xx, 3xx, unknown.
 *   - `reauth_required` → 401 / 403 — token rejected / grant revoked.
 *   - `persistent`      → any other 4xx — malformed request / contract drift.
 */

export type OuraClassification =
  | "success"
  | "transient"
  | "reauth_required"
  | "persistent";

export interface ClassifiedOuraResponse {
  classification: OuraClassification;
  httpStatus: number | undefined;
  reason: string;
}

export function classifyOuraResponse(
  httpStatus: number,
): ClassifiedOuraResponse {
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

export class OuraApiError extends Error {
  readonly classification: OuraClassification;
  readonly httpStatus: number | undefined;
  readonly reason: string;
  readonly verb: string;
  readonly upstreamError: string | undefined;

  constructor(opts: {
    verb: string;
    classification: OuraClassification;
    httpStatus: number | undefined;
    reason: string;
    upstreamError?: string;
  }) {
    const statusLabel =
      typeof opts.httpStatus === "number" ? opts.httpStatus : "?";
    const errSegment = opts.upstreamError ? ` - ${opts.upstreamError}` : "";
    const raw = `Oura ${opts.verb} error: ${statusLabel}${errSegment}`;
    super(raw.slice(0, 1024));
    this.name = "OuraApiError";
    this.verb = opts.verb;
    this.classification = opts.classification;
    this.httpStatus = opts.httpStatus;
    this.reason = opts.reason;
    this.upstreamError = opts.upstreamError;
  }
}

/**
 * True when a caught error is an OAuth `invalid_grant` on the token endpoint —
 * the canonical revoked-refresh-token signal. Lifts a 400 carrying
 * `invalid_grant` from `persistent` to `reauth_required` so the connection
 * surfaces the reconnect prompt.
 */
export function isInvalidGrant(err: unknown): boolean {
  if (err instanceof OuraApiError) {
    if (err.httpStatus !== 400) return false;
    if (err.upstreamError === "invalid_grant") return true;
    return /\binvalid_grant\b/.test(err.message);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /Oura\s+\w+\s+error:\s*400\b[\s\S]*\binvalid_grant\b/.test(msg);
}

export function classifyOuraError(err: unknown): OuraClassification {
  if (isInvalidGrant(err)) return "reauth_required";
  if (err instanceof OuraApiError) return err.classification;
  const msg = err instanceof Error ? err.message : String(err);
  const m = /Oura\s+\w+\s+error:\s*(\d+)/.exec(msg);
  if (!m) return "transient";
  const status = Number.parseInt(m[1]!, 10);
  if (!Number.isFinite(status)) return "transient";
  return classifyOuraResponse(status).classification;
}
