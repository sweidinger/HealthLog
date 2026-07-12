/**
 * v1.28.30 — does a cached comprehensive payload actually carry a daily
 * briefing?
 *
 * Shared by the generator's content-hash gate and the POST route's 24 h
 * short-circuit: a fresh-but-briefingless cache must not satisfy a
 * briefing-expecting caller for the rest of the day (the "one silent
 * nightly failure + 24 h cache = a full day without a briefing" chain).
 * Unparseable text counts as briefingless — regeneration repairs it.
 *
 * Lives in its own leaf module (no provider-tree imports) so the route
 * can consume it without pulling the whole generation pipeline into its
 * bundle, and tests that mock `comprehensive-generate` keep the real
 * implementation.
 */
export function cachedPayloadCarriesBriefing(
  cachedText: string | null | undefined,
): boolean {
  if (!cachedText) return false;
  try {
    const parsed = JSON.parse(cachedText) as Record<string, unknown>;
    return parsed.dailyBriefing != null;
  } catch {
    return false;
  }
}
