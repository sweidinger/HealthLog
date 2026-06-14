import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { annotate } from "@/lib/logging/context";
import { getOuraConnection } from "@/lib/oura/credentials";
import { safeFetch, SafeFetchError } from "@/lib/safe-fetch";

export const dynamic = "force-dynamic";

// Lightweight token probe — fetch the personal-info record, the cheapest
// authenticated Oura call that confirms the stored grant is still valid.
// Reuses `getOuraConnection`; no new credential path.
// Base from `src/lib/oura/client.ts` (`OURA_API_BASE`).
const OURA_PERSONAL_INFO_URL =
  "https://api.ouraring.com/v2/usercollection/personal_info";
const TIMEOUT_MS = 5_000;

function categoriseHttpStatus(status: number): { code: string; message: string } {
  if (status === 401 || status === 403) {
    return { code: "credentials_rejected", message: "Oura rejected the token" };
  }
  if (status === 429) {
    return { code: "rate_limited", message: "Oura rate-limited the request" };
  }
  if (status >= 500) {
    return { code: "upstream_error", message: "Oura returned a server error" };
  }
  return { code: "connection_failed", message: "Oura connection failed" };
}

export const POST = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "oura.test" } });

  const rl = await checkRateLimit(`oura-test:${user.id}`, 5, 60_000);
  if (!rl.allowed) {
    return apiError("Too many test requests", 429, {
      errorCode: "rate_limited_self",
    });
  }

  const connection = await getOuraConnection(user.id);
  if (!connection) {
    return apiError("Oura not connected", 422, { errorCode: "not_configured" });
  }

  const start = performance.now();

  try {
    const res = await safeFetch(
      OURA_PERSONAL_INFO_URL,
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
        meta: { oura_test_status: res.status, oura_test_code: cat.code },
      });
      return apiError(cat.message, 502, { errorCode: cat.code });
    }

    return apiSuccess({ ok: true, latencyMs });
  } catch (e) {
    const isTimeout = e instanceof SafeFetchError && e.kind === "timeout";
    const code = isTimeout ? "timeout" : "connection_failed";
    annotate({ meta: { oura_test_code: code } });
    return apiError(
      isTimeout ? "Oura request timed out" : "Oura connection failed",
      502,
      { errorCode: code },
    );
  }
});
