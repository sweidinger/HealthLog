/**
 * v1.17.0 (F4) — off-response classifier for Oura Cloud API v2 replies.
 * HTTP-status-driven; the shared core lives in
 * `src/lib/integrations/http-status-classifier.ts` and is re-exported here
 * under the Oura-specific names callers already use.
 *
 *   - `success`         → HTTP 2xx
 *   - `transient`       → 429 (rate-limited), 5xx, 3xx, unknown.
 *   - `reauth_required` → 401 / 403 — token rejected / grant revoked.
 *   - `persistent`      → any other 4xx — malformed request / contract drift.
 */

import {
  classifyHttpStatus,
  classifyIntegrationError,
  IntegrationApiError,
  isOAuthInvalidGrant,
  type ClassifiedHttpResponse,
  type IntegrationClassification,
} from "@/lib/integrations/http-status-classifier";

export type OuraClassification = IntegrationClassification;

export type ClassifiedOuraResponse = ClassifiedHttpResponse;

export function classifyOuraResponse(
  httpStatus: number,
): ClassifiedOuraResponse {
  return classifyHttpStatus(httpStatus);
}

export class OuraApiError extends IntegrationApiError {
  constructor(opts: {
    verb: string;
    classification: OuraClassification;
    httpStatus: number | undefined;
    reason: string;
    upstreamError?: string;
  }) {
    super({ vendor: "Oura", ...opts });
    this.name = "OuraApiError";
  }
}

/**
 * True when a caught error is an OAuth `invalid_grant` on the token endpoint —
 * the canonical revoked-refresh-token signal. Lifts a 400 carrying
 * `invalid_grant` from `persistent` to `reauth_required` so the connection
 * surfaces the reconnect prompt.
 */
export function isInvalidGrant(err: unknown): boolean {
  return isOAuthInvalidGrant(err, "Oura");
}

export function classifyOuraError(err: unknown): OuraClassification {
  if (isInvalidGrant(err)) return "reauth_required";
  return classifyIntegrationError(err, "Oura");
}
