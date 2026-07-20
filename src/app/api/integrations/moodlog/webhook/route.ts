import { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";
import { apiError } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/api-response";
import { moodLogWebhookPayloadSchema } from "@/lib/validations/moodlog";
import { readMoodLogSecret } from "@/lib/moodlog-secret";
import { persistMoodLogSourceEntry } from "@/lib/moodlog/persistence";
import { apiHandler } from "@/lib/api-handler";
import { annotate, getEvent } from "@/lib/logging/context";
import { recomputeMoodBucketsForEntry } from "@/lib/rollups/mood-rollups";

export const dynamic = "force-dynamic";

/**
 * @deprecated The standalone moodLog webhook is superseded by native mood
 * entries plus structured tags and rated factors — mood is now tracked
 * fully inside HealthLog, so the external moodLog bridge no longer adds
 * anything. Kept functional for existing integrations; slated for removal
 * in a future major release. Do not build new callers against it.
 */
export const POST = apiHandler(async (request: NextRequest) => {
  annotate({ action: { name: "moodlog.webhook" } });

  // 1. Rate limit (30/min per IP)
  const ip = getClientIp(request) ?? "unknown";
  const rl = await checkRateLimit(`moodlog-webhook:${ip}`, 30, 60_000);
  if (!rl.allowed) {
    return apiError("Rate limit exceeded", 429);
  }

  // 2. Check global toggle
  const appSettings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
    select: { moodLogGlobal: true },
  });
  if (appSettings && !appSettings.moodLogGlobal) {
    return apiError("moodLog integration is disabled", 403);
  }

  // 3. Get webhook secret from header
  const webhookSecret = request.headers.get("x-webhook-secret");
  if (!webhookSecret) {
    return apiError("Missing X-Webhook-Secret header", 401);
  }

  // 4. Find all enabled users with webhook secrets and compare timing-safe
  const candidates = await prisma.user.findMany({
    where: {
      moodLogEnabled: true,
      moodLogWebhookSecret: { not: null },
    },
    select: { id: true, moodLogWebhookSecret: true },
  });

  // V3 audit STILL-V2-C-2: stored secret is now encrypted at rest. Decrypt
  // each candidate before the timing-safe compare. `readMoodLogSecret`
  // also tolerates legacy plaintext rows during the transition window.
  const receivedBuf = Buffer.from(webhookSecret, "utf8");
  const user = candidates.find((c) => {
    const expected = readMoodLogSecret(c.moodLogWebhookSecret);
    if (!expected) return false;
    const expectedBuf = Buffer.from(expected, "utf8");
    if (expectedBuf.length !== receivedBuf.length) return false;
    return timingSafeEqual(expectedBuf, receivedBuf);
  });

  if (!user) {
    return apiError("Invalid webhook secret", 401);
  }

  getEvent()?.setAuth({ user_id: user.id, auth_method: "webhook_secret" });

  // 5. Parse body
  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (raw.length > 256 * 1024) {
      return apiError(`Request body exceeds ${256 * 1024} bytes`, 413);
    }
    body = JSON.parse(raw);
  } catch {
    return apiError("Invalid JSON", 400);
  }

  // Handle test pings from moodLog's "Test senden" button
  if (body.event === "webhook.test") {
    annotate({ meta: { webhook_event: "webhook.test" } });
    return new Response(null, { status: 200 });
  }

  const parsed = moodLogWebhookPayloadSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid payload", 400);
  }

  const { event, entry } = parsed.data;
  annotate({ meta: { webhook_event: event } });

  // 5. Process event and acknowledge only after the source write commits.
  const moodLoggedAt = new Date(entry.time);
  // v1.12.1 — when the upstream supplies a stable entry id, dedup on
  // `(userId, source, externalId)` so a re-emit with a re-rounded /
  // re-zoned `time` updates the same row instead of minting a duplicate.
  // Absent → the legacy `(userId, date, moodLoggedAt)` key. MOODLOG is
  // the fixed source here, matching the create/update writes below.
  const externalId = entry.id ?? null;

  try {
    if (event === "mood.deleted") {
      await prisma.moodEntry.deleteMany({
        where: {
          userId: user.id,
          ...(externalId
            ? { source: "MOODLOG", externalId }
            : { date: entry.date, moodLoggedAt }),
        },
      });
    } else {
      await persistMoodLogSourceEntry(user.id, {
        externalId,
        date: entry.date,
        moodLoggedAt,
        mood: entry.mood,
        score: entry.score,
        tags: entry.tags,
      });
    }

    // v1.4.39 W-MOOD — refresh the persisted rollup for the entry's
    // bucket. Inline best-effort: a failure here must not block the
    // webhook 200 response (the rollup is a cache tier, the source-of-
    // truth is the mood_entries write that already committed).
    try {
      await recomputeMoodBucketsForEntry(user.id, moodLoggedAt);
    } catch (rollupErr) {
      getEvent()?.addWarning(
        "Mood rollup recompute failed: " +
          (rollupErr instanceof Error ? rollupErr.message : String(rollupErr)),
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    getEvent()?.addWarning(`MoodLog source persistence failed: ${message}`);
    return apiError("Failed to persist moodLog event", 503);
  }

  // 6. The source record is durable; the provider can stop retrying.
  return new Response(null, { status: 200 });
});
