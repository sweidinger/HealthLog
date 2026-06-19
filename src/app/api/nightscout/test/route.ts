import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { annotate } from "@/lib/logging/context";
import { getUserNightscoutCredentials } from "@/lib/nightscout/credentials";
import { fetchSgvEntries, NightscoutApiError } from "@/lib/nightscout/client";
import { SafeFetchError } from "@/lib/safe-fetch";

export const dynamic = "force-dynamic";

// Cheap live probe — re-validate the stored URL + token by pulling a single
// SGV entry off the user's instance via the same client the sync uses. No new
// credentials path: it reuses `getUserNightscoutCredentials` + `fetchSgvEntries`.
const TIMEOUT_MS = 5_000;

function categoriseStatus(status: number | null): {
  code: string;
  message: string;
} {
  if (status === 401 || status === 403) {
    return {
      code: "credentials_rejected",
      message: "Nightscout rejected the token",
    };
  }
  if (status === 429) {
    return {
      code: "rate_limited",
      message: "Nightscout rate-limited the request",
    };
  }
  if (status !== null && status >= 500) {
    return { code: "upstream_error", message: "Nightscout returned an error" };
  }
  return { code: "connection_failed", message: "Nightscout connection failed" };
}

export const POST = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "nightscout.test" } });

  const rl = await checkRateLimit(`nightscout-test:${user.id}`, 5, 60_000);
  if (!rl.allowed) {
    return apiError("Too many test requests", 429, {
      errorCode: "rate_limited_self",
    });
  }

  const creds = await getUserNightscoutCredentials(user.id);
  if (!creds) {
    return apiError("Nightscout not connected", 422, {
      errorCode: "not_configured",
    });
  }

  const start = performance.now();

  try {
    await fetchSgvEntries({
      baseUrl: creds.baseUrl,
      token: creds.token,
      count: 1,
      allowPrivateHost: creds.allowPrivateHost,
      timeoutMs: TIMEOUT_MS,
    });
    const latencyMs = Math.round(performance.now() - start);
    return apiSuccess({ ok: true, latencyMs });
  } catch (e) {
    if (e instanceof NightscoutApiError) {
      const cat = categoriseStatus(e.status);
      annotate({
        meta: {
          nightscout_test_status: e.status,
          nightscout_test_code: cat.code,
        },
      });
      return apiError(cat.message, 502, { errorCode: cat.code });
    }
    const isTimeout = e instanceof SafeFetchError && e.kind === "timeout";
    const isPrivate = e instanceof SafeFetchError && e.kind === "private_host";
    const code = isTimeout
      ? "timeout"
      : isPrivate
        ? "url_not_public"
        : "connection_failed";
    annotate({ meta: { nightscout_test_code: code } });
    return apiError(
      isTimeout
        ? "Nightscout request timed out"
        : "Nightscout connection failed",
      502,
      { errorCode: code },
    );
  }
});
