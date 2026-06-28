/**
 * `GET /api/environment/geocode?q=` — forward-geocode a city to coarse matches.
 *
 * Proxies Open-Meteo's keyless geocoding through the server (so the browser
 * never calls the third-party host and the CSP stays untouched) and returns
 * coarse rounded coordinates + label + timezone for the home-location picker.
 * Module-gated + rate-limited; `userId` is narrowed from auth.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { checkAnalyticsReadRateLimit } from "@/lib/rate-limit";
import { geocodeQuerySchema } from "@/lib/validations/environment";
import { geocodeLocation } from "@/lib/environment/open-meteo";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const gate = await requireModuleEnabled(user.id, "environment");
  if (!gate.enabled) return gate.response;

  // Reuse the analytics-read budget: a city search is a cheap outbound call,
  // but the generous bucket caps a runaway autocomplete loop.
  const rl = await checkAnalyticsReadRateLimit(user.id);
  if (!rl.allowed) {
    return apiError("Too many requests. Please retry shortly.", 429);
  }

  const params = new URL(request.url).searchParams;
  const parsed = geocodeQuerySchema.safeParse({ q: params.get("q") ?? "" });
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "environment.invalid",
    });
  }

  const results = await geocodeLocation(parsed.data.q);

  annotate({
    action: { name: "environment.geocode.search" },
    meta: { result_count: results.length },
  });

  return apiSuccess({ results });
});
