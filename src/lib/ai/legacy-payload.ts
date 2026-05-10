/**
 * v1.4.16 phase B5c — legacy-payload detection.
 *
 * Cached insight blobs persisted before B5c shipped don't carry the
 * `rationale` field. The /api/insights/generate route surfaces a
 * `legacyPayload: true` flag on cache-hit so the UI can render a
 * "Insights updated — regenerate for new explainability features"
 * CTA. User-initiated regeneration stays the trigger; we do NOT
 * auto-regenerate on cache-hit (that would burn rate-limit tokens
 * silently and surprise users who explicitly toggled cache-only).
 *
 * Detection is lenient on purpose: the cached payload may carry
 * either the canonical `AIInsightResponse` shape (structured recs)
 * or the legacy `InsightResult` shape (string-only recommendations).
 * Both predate B5c rationale; both flag.
 */

/**
 * Returns true when the payload is non-empty and at least one
 * recommendation lacks a rationale object (or is a plain string from
 * the v1.4.14/v1.4.15 InsightResult shape).
 *
 * - Non-object / null / undefined input → false (nothing to migrate).
 * - Missing recommendations[] → false (refusal payload, not legacy).
 * - Empty recommendations[] → false (no recs to migrate).
 * - Any rec is a plain string → true.
 * - Any rec is an object missing `rationale` → true.
 * - Otherwise → false.
 */
export function isLegacyInsightPayload(payload: unknown): boolean {
  if (payload === null || payload === undefined) return false;
  if (typeof payload !== "object") return false;
  const recs = (payload as { recommendations?: unknown }).recommendations;
  if (!Array.isArray(recs)) return false;
  if (recs.length === 0) return false;
  for (const rec of recs) {
    // Legacy InsightResult shape: string-only recommendations[]
    if (typeof rec === "string") return true;
    // Structured rec: rationale must be a populated object.
    if (rec === null || typeof rec !== "object") return true;
    const rationale = (rec as { rationale?: unknown }).rationale;
    if (
      rationale === undefined ||
      rationale === null ||
      typeof rationale !== "object"
    ) {
      return true;
    }
  }
  return false;
}
