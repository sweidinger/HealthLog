import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { annotate, getEvent } from "@/lib/logging/context";
import {
  applyWebhookRateLimit,
  processWhoopNotification,
  timingSafeStringEqual,
  verifyWhoopSignature,
} from "@/lib/whoop/webhook-handler";

/**
 * WHOOP webhook entrypoint (v1.11.0). Mirrors the Withings path-segment
 * secret shape and adds the HMAC body-signature verification WHOOP supports.
 *
 * Auth, in order — every leg short-circuits with no work done on failure:
 *   1. per-source rate limit (BEFORE secret verify — DoS floor);
 *   2. path-segment secret `timingSafeStringEqual` against
 *      `WHOOP_WEBHOOK_SECRET` (scrubbed from logs by `PATH_SECRET_PATHS`);
 *   3. HMAC body signature `timingSafeEqual` over the RAW request bytes +
 *      a stale-timestamp reject.
 *
 * The path segment keeps the secret out of the reverse-proxy `query_string`
 * access-log column; the HMAC binds the request body so a captured URL alone
 * can't forge a delivery.
 */
interface RouteContext {
  params: Promise<{ token: string }>;
}

async function verifyTokenSegment(
  token: string | undefined,
): Promise<boolean> {
  const expected = process.env.WHOOP_WEBHOOK_SECRET;
  if (!expected) {
    getEvent()?.addWarning("WHOOP_WEBHOOK_SECRET not configured");
    return false;
  }
  if (!token) return false;
  return timingSafeStringEqual(expected, token);
}

export const POST = apiHandler(
  async (request: NextRequest, context: RouteContext) => {
    annotate({ action: { name: "whoop.webhook" } });

    // (1) Rate-limit BEFORE any secret / signature work.
    const limited = await applyWebhookRateLimit(request);
    if (limited) return limited;

    // (2) Path-segment secret.
    const { token } = await context.params;
    if (!(await verifyTokenSegment(token))) {
      return NextResponse.json({ status: "unauthorized" }, { status: 401 });
    }

    // (3) HMAC body signature over the RAW bytes. Read the body as text
    // exactly once — `request.json()` would consume it and defeat the
    // signature check.
    const rawBody = await request.text();
    const secret = process.env.WHOOP_WEBHOOK_SECRET;
    if (
      !secret ||
      !verifyWhoopSignature({
        rawBody,
        signature: request.headers.get("X-WHOOP-Signature"),
        timestamp: request.headers.get("X-WHOOP-Signature-Timestamp"),
        secret,
      })
    ) {
      annotate({ action: { name: "whoop.webhook.bad_signature" } });
      return NextResponse.json({ status: "unauthorized" }, { status: 401 });
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ status: "ignored" }, { status: 200 });
    }
    if (typeof body !== "object" || body === null) {
      return NextResponse.json({ status: "ignored" }, { status: 200 });
    }

    return processWhoopNotification(body);
  },
);
