/**
 * v1.8.7.1 — on-demand full assessment warm.
 *
 * `POST /api/insights/pregenerate` enqueues a forced full warm of every
 * AI assessment for the calling user — the comprehensive insight (daily
 * briefing), the seven specialised `*-status` cards, and every
 * data-bearing generic `metric:<ID>` assessment — for the user's active
 * locale. The heavy generation runs on the worker (the
 * `insight-pregenerate` queue) so this route returns immediately; the
 * cards then fill via the existing read-only stale-while-revalidate GETs
 * without the user waiting on a provider round-trip.
 *
 * The forced path bypasses the nightly cron's per-user 20 h budget (so a
 * user can warm on demand the moment they land on the page), so this
 * route carries its own short anti-spam bucket — one warm per
 * `WARM_WINDOW_MS` per user. Empty metrics never reach the provider (the
 * worker filters to data-bearing types) and the comprehensive generator
 * no-ops without a configured provider, so a spam-free call on a
 * provider-less account costs one cheap chain-resolve and no LLM call.
 *
 * `userId` is always narrowed from the session / Bearer — never a body
 * field. Both web and the iOS client can call it; they read the same
 * cached routes afterward.
 */
import { NextRequest } from "next/server";
import { apiSuccess, apiError } from "@/lib/api-response";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { requireAssistantSurface } from "@/lib/feature-flags";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { checkRateLimit } from "@/lib/rate-limit";
import { annotate } from "@/lib/logging/context";
import { resolveServerLocale } from "@/lib/i18n/server-locale";
import { enqueueForceWarm } from "@/lib/jobs/insight-pregenerate-shared";

export const dynamic = "force-dynamic";

/** Anti-spam window — one forced warm per user per 3 minutes. */
const WARM_WINDOW_MS = 3 * 60 * 1000;

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  const m = await requireModuleEnabled(user.id, "insights");
  if (!m.enabled) return m.response;
  // Gate on the same surface as the read-only status routes: this warms
  // the assessment cards (the `insightStatus` surface), not the Coach.
  // A user with assessments enabled but Coach disabled can still warm.
  await requireAssistantSurface("insightStatus");
  const userId = user.id;

  // Short per-user bucket so the bypassed nightly budget can't be abused
  // into a provider-cost amplifier by a tight POST loop. A blocked call
  // is harmless — the caches are already being warmed by the prior call.
  const rl = await checkRateLimit(`insights-warm:${userId}`, 1, WARM_WINDOW_MS);
  if (!rl.allowed) {
    return apiError("A warm is already in progress. Try again shortly.", 429);
  }

  const resolved = await resolveServerLocale({
    request,
    userLocale: user.locale ?? null,
  });
  const locale = resolved === "en" ? "en" : "de";

  await enqueueForceWarm({ userId, locale });

  annotate({
    action: { name: "insights.pregenerate.requested" },
    meta: { locale },
  });

  // The work runs on the worker; report that it was accepted, not that it
  // is done. The client polls the read-only status GETs for the text.
  return apiSuccess({ queued: true, locale });
});
