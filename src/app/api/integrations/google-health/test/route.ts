import type { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { getValidToken } from "@/lib/google-health/sync";
import { GOOGLE_HEALTH_API_BASE } from "@/lib/google-health/client";
import { safeFetch, SafeFetchError } from "@/lib/safe-fetch";

export const dynamic = "force-dynamic";

// Cheap authenticated probe — the single (non-paginated) profile endpoint the
// Google Health client already calls via `fetchProfile`.
// Base from `src/lib/google-health/client.ts` (`GOOGLE_HEALTH_API_BASE`).
const GOOGLE_HEALTH_PROFILE_URL = `${GOOGLE_HEALTH_API_BASE}/users/me/profile`;
const TIMEOUT_MS = 5_000;

type CategorisedError = { code: string; message: string };

function categoriseHttpStatus(status: number): CategorisedError {
  if (status === 401 || status === 403) {
    return {
      code: "credentials_rejected",
      message: "Google Health rejected the credentials",
    };
  }
  if (status === 429) {
    return {
      code: "rate_limited",
      message: "Google Health rate-limited the request",
    };
  }
  if (status >= 500) {
    return {
      code: "upstream_error",
      message: "Google Health returned a server error",
    };
  }
  return {
    code: "connection_failed",
    message: "Google Health connection failed",
  };
}

export const POST = apiHandler(async (request: NextRequest) => {
  void request;
  const { user } = await requireAuth();
  annotate({ action: { name: "integrations.google-health.test" } });

  const rl = await checkRateLimit(`google-health-test:${user.id}`, 5, 60_000);
  if (!rl.allowed) {
    return apiError("Too many test requests", 429, {
      errorCode: "rate_limited_self",
    });
  }

  const tokenInfo = await getValidToken(user.id);
  if (!tokenInfo) {
    return apiError("Google Health not connected", 422, {
      errorCode: "not_configured",
    });
  }

  const connection = await prisma.googleHealthConnection.findUnique({
    where: { userId: user.id },
    select: { lastSyncedAt: true },
  });

  const start = performance.now();

  try {
    const res = await safeFetch(
      GOOGLE_HEALTH_PROFILE_URL,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${tokenInfo.accessToken}`,
        },
      },
      { timeoutMs: TIMEOUT_MS },
    );
    const latencyMs = Math.round(performance.now() - start);

    if (!res.ok) {
      const cat = categoriseHttpStatus(res.status);
      annotate({
        meta: {
          google_health_test_status: res.status,
          google_health_test_code: cat.code,
          google_health_test_latency_ms: latencyMs,
        },
      });
      return apiError(cat.message, 502, { errorCode: cat.code });
    }

    return apiSuccess({
      ok: true,
      lastSyncedAt: connection?.lastSyncedAt ?? null,
      latencyMs,
    });
  } catch (e) {
    const err = e as Error;
    // safeFetch wraps timeouts into SafeFetchError{kind:"timeout"};
    // legacy AbortError name is preserved for compatibility with any
    // future direct-fetch path that still reaches this catch.
    const isAbort =
      (e instanceof SafeFetchError && e.kind === "timeout") ||
      err.name === "AbortError";
    const code = isAbort ? "timeout" : "connection_failed";
    annotate({
      meta: {
        google_health_test_code: code,
        google_health_test_error: redact(err.message).slice(0, 300),
      },
    });
    return apiError(
      isAbort
        ? "Google Health request timed out"
        : "Google Health connection failed",
      502,
      { errorCode: code },
    );
  }
});

// Strip any `Bearer <token>` substring before annotating; the catch path can
// see DNS / TLS errors that include the request init via err.cause in some
// runtimes, and we never want a token in Loki.
function redact(text: string): string {
  return text.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
}
