import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { annotate } from "@/lib/logging/context";
import { getPolarConnection } from "@/lib/polar/credentials";
import { safeFetch, SafeFetchError } from "@/lib/safe-fetch";

export const dynamic = "force-dynamic";

// Lightweight token probe — fetch the registered AccessLink user record, the
// cheapest authenticated Polar call that confirms the stored grant is still
// valid. Reuses `getPolarConnection`; no new credential path.
// Base from `src/lib/polar/client.ts` (`POLAR_API_BASE`).
const POLAR_USERS_BASE = "https://www.polaraccesslink.com/v3/users";
const TIMEOUT_MS = 5_000;

function categoriseHttpStatus(status: number): { code: string; message: string } {
  if (status === 401 || status === 403) {
    return { code: "credentials_rejected", message: "Polar rejected the token" };
  }
  if (status === 429) {
    return { code: "rate_limited", message: "Polar rate-limited the request" };
  }
  if (status >= 500) {
    return { code: "upstream_error", message: "Polar returned a server error" };
  }
  return { code: "connection_failed", message: "Polar connection failed" };
}

export const POST = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "polar.test" } });

  const rl = await checkRateLimit(`polar-test:${user.id}`, 5, 60_000);
  if (!rl.allowed) {
    return apiError("Too many test requests", 429, {
      errorCode: "rate_limited_self",
    });
  }

  const connection = await getPolarConnection(user.id);
  if (!connection) {
    return apiError("Polar not connected", 422, { errorCode: "not_configured" });
  }

  const start = performance.now();

  try {
    const res = await safeFetch(
      `${POLAR_USERS_BASE}/${encodeURIComponent(connection.polarUserId)}`,
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
        meta: { polar_test_status: res.status, polar_test_code: cat.code },
      });
      return apiError(cat.message, 502, { errorCode: cat.code });
    }

    return apiSuccess({ ok: true, latencyMs });
  } catch (e) {
    const isTimeout = e instanceof SafeFetchError && e.kind === "timeout";
    const code = isTimeout ? "timeout" : "connection_failed";
    annotate({ meta: { polar_test_code: code } });
    return apiError(
      isTimeout ? "Polar request timed out" : "Polar connection failed",
      502,
      { errorCode: code },
    );
  }
});
