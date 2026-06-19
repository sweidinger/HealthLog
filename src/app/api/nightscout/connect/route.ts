import { NextRequest } from "next/server";
import { z } from "zod/v4";

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, apiError, safeJson } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { encrypt } from "@/lib/crypto";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { markReconnected } from "@/lib/integrations/status";
import { SafeFetchError } from "@/lib/safe-fetch";
import { fetchSgvEntries, NightscoutApiError } from "@/lib/nightscout/client";
import { nightscoutConnectSchema } from "@/lib/validations/nightscout";

/**
 * Connect (or update) the user's Nightscout instance (v1.17.0).
 *
 * Validates the URL + token by a live TEST FETCH of one SGV entry before
 * storing anything — a wrong token (401/403), an unreachable instance, or a
 * private host the user didn't opt into all surface as a clear error here
 * rather than silently parking the integration on its first cron tick.
 *
 * On success the URL + token are encrypted at rest on `User` and the
 * `nightscout` integration ledger is reset to connected. Per-user rate-limited
 * (a test fetch is an outbound call; throttle the connect surface so a tight
 * retry loop can't be used to probe arbitrary hosts).
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "nightscout.connect" } });

  const rl = await checkRateLimit(`nightscout-connect:${user.id}`, 10, 60_000);
  if (!rl.allowed) {
    return apiError("Too many connection attempts", 429, {
      headers: rateLimitHeaders(rl),
    });
  }

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 16 * 1024,
  });
  if (jsonError) return jsonError;

  const result = z.safeParse(nightscoutConnectSchema, body);
  if (!result.success) {
    return apiError("A valid Nightscout URL is required", 422);
  }

  const { url, token, allowPrivateHost } = result.data;

  // Live validation: pull a single SGV entry. A connection that can't even
  // fetch one row is not worth storing.
  try {
    await fetchSgvEntries({
      baseUrl: url,
      token,
      count: 1,
      allowPrivateHost,
    });
  } catch (err) {
    if (err instanceof SafeFetchError && err.kind === "private_host") {
      return apiError(
        "That instance is on a private network. Enable the private-network option to connect to it.",
        422,
      );
    }
    if (err instanceof NightscoutApiError) {
      if (err.status === 401 || err.status === 403) {
        return apiError(
          "Nightscout rejected the token. Check the API token and try again.",
          422,
        );
      }
      return apiError(
        "Could not reach the Nightscout instance. Check the URL and that it is online.",
        422,
      );
    }
    return apiError(
      "Could not reach the Nightscout instance. Check the URL and that it is online.",
      422,
    );
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      // Build the data object field-by-field — never spread the parsed body.
      nightscoutUrlEncrypted: encrypt(url),
      nightscoutTokenEncrypted: token ? encrypt(token) : null,
      nightscoutAllowPrivateHost: allowPrivateHost,
    },
  });

  await markReconnected(user.id, "nightscout");
  await auditLog("nightscout.connect", { userId: user.id });

  return apiSuccess({ connected: true });
});
