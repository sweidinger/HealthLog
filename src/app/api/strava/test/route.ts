import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { annotate } from "@/lib/logging/context";
import { getStravaConnection } from "@/lib/strava/credentials";
import { safeFetch, SafeFetchError } from "@/lib/safe-fetch";

export const dynamic = "force-dynamic";

// Lightweight token probe — fetch the authenticated athlete, the cheapest
// authenticated Strava call that confirms the stored grant is still valid.
// Reuses `getStravaConnection`; no new credential path.
const STRAVA_ATHLETE_URL = "https://www.strava.com/api/v3/athlete";
const TIMEOUT_MS = 5_000;

function categoriseHttpStatus(status: number): {
  code: string;
  message: string;
} {
  if (status === 401 || status === 403) {
    return {
      code: "credentials_rejected",
      message: "Strava rejected the token",
    };
  }
  if (status === 429) {
    return { code: "rate_limited", message: "Strava rate-limited the request" };
  }
  if (status >= 500) {
    return {
      code: "upstream_error",
      message: "Strava returned a server error",
    };
  }
  return { code: "connection_failed", message: "Strava connection failed" };
}

export const POST = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "strava.test" } });

  const rl = await checkRateLimit(`strava-test:${user.id}`, 5, 60_000);
  if (!rl.allowed) {
    return apiError("Too many test requests", 429, {
      errorCode: "rate_limited_self",
    });
  }

  const connection = await getStravaConnection(user.id);
  if (!connection) {
    return apiError("Strava not connected", 422, {
      errorCode: "not_configured",
    });
  }

  const start = performance.now();

  try {
    const res = await safeFetch(
      STRAVA_ATHLETE_URL,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${connection.accessToken}`,
          Accept: "application/json",
        },
      },
      { timeoutMs: TIMEOUT_MS },
    );
    const latencyMs = Math.round(performance.now() - start);

    if (!res.ok) {
      const cat = categoriseHttpStatus(res.status);
      annotate({
        meta: { strava_test_status: res.status, strava_test_code: cat.code },
      });
      return apiError(cat.message, 502, { errorCode: cat.code });
    }

    return apiSuccess({ ok: true, latencyMs });
  } catch (e) {
    const isTimeout = e instanceof SafeFetchError && e.kind === "timeout";
    const code = isTimeout ? "timeout" : "connection_failed";
    annotate({ meta: { strava_test_code: code } });
    return apiError(
      isTimeout ? "Strava request timed out" : "Strava connection failed",
      502,
      { errorCode: code },
    );
  }
});
