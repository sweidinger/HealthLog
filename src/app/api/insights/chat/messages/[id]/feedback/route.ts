/**
 * v1.4.23 H7 — Coach assistant-message helpful/unhelpful feedback.
 *
 * POST /api/insights/chat/messages/:id/feedback
 *   Body: { rating: "helpful" | "unhelpful", reason?: string }
 *
 * Reuses the v1.4.16 B5e `RecommendationFeedback` table via the
 * polymorphic `targetType` field added in migration
 * `0040_recommendation_feedback_target_type`. Each Coach feedback row
 * snapshots the user's active prompt-tuning prefs (tone + verbosity)
 * into `metricSourceType` so the daily aggregator can bucket
 * helpful-rate per (promptVersion, tone, verbosity) without a join.
 *
 * The route enforces ownership: the message id must belong to a
 * conversation the authenticated user owns. Cross-account submissions
 * return 404 (never 403 — same lesson as the conversation route, no
 * cross-user existence leak).
 *
 * Idempotency: the existing unique
 * `(userId, recommendationId, recommendationText)` index already
 * dedupes a replay submission for the same message + same prose
 * snapshot. A re-rating after the user changes their mind requires the
 * UI to delete + re-create — out of scope for v1.4.23 H7.
 */
import type { NextRequest } from "next/server";
import { z } from "zod/v4";

import { apiHandler, requireAuth, HttpError } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp, safeJson } from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { resolveCoachFeedbackAttribution } from "@/lib/ai/feedback-attribution";
import { decrypt } from "@/lib/crypto";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit } from "@/lib/rate-limit";

const coachMessageFeedbackSchema = z.object({
  rating: z.enum(["helpful", "unhelpful"]),
  reason: z.string().min(1).max(200).optional(),
});

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function handlePost(request: NextRequest, ctx: RouteContext) {
  const { user } = await requireAuth();
  const { id: messageId } = await ctx.params;

  // Per-user rate limit — same shape as the recommendation feedback
  // route (60/h). Keeps a chatty client from drowning the bucketing
  // signal.
  const rl = await checkRateLimit(
    `coach-feedback:${user.id}`,
    60,
    60 * 60 * 1000,
  );
  if (!rl.allowed) {
    annotate({
      action: { name: "insights.coach.message.feedback" },
      meta: { outcome: "rate_limited" },
    });
    return apiError("Too many feedback submissions, try again later", 429);
  }

  const { data: rawBody, error } = await safeJson<unknown>(request);
  if (error) return error;
  const parsed = coachMessageFeedbackSchema.safeParse(rawBody);
  if (!parsed.success) {
    annotate({
      action: { name: "insights.coach.message.feedback" },
      meta: { outcome: "validation_failed" },
    });
    throw new HttpError(422, "feedback.body.invalid");
  }
  const body = parsed.data;

  // Verify ownership + pull the prose snapshot. The encrypted-content
  // model stores the message body via AES-256-GCM; decrypt to use as
  // the `recommendationText` slot so the per-(user, message, text)
  // dedup remains stable across re-rates.
  const message = await prisma.coachMessage.findFirst({
    where: {
      id: messageId,
      role: "assistant",
      conversation: { userId: user.id },
    },
    select: { id: true, encryptedContent: true },
  });
  if (!message) {
    annotate({
      action: { name: "insights.coach.message.feedback" },
      meta: { outcome: "not_found" },
    });
    throw new HttpError(404, "coach.message.notFound");
  }

  let proseSnapshot = "";
  try {
    const ciphertext = Buffer.from(message.encryptedContent).toString("utf8");
    proseSnapshot = decrypt(ciphertext);
  } catch {
    // Decryption failure shouldn't block the feedback row — fall back
    // to a stable id-keyed marker so the dedup still works.
    proseSnapshot = `<undecryptable:${messageId}>`;
  }
  // Cap the snapshot at the same byte budget the rec-feedback table
  // already accepts (a Coach reply is usually ~400-1500 chars; clip
  // hard at 4 KB so a runaway provider can't bloat the table).
  if (proseSnapshot.length > 4096) {
    proseSnapshot = proseSnapshot.slice(0, 4096);
  }

  const attribution = await resolveCoachFeedbackAttribution(user.id, messageId);

  try {
    const created = await prisma.recommendationFeedback.create({
      data: {
        userId: user.id,
        recommendationId: messageId,
        recommendationText: proseSnapshot,
        recommendationSeverity: "coach",
        metricSourceType: attribution.metricSourceType,
        metricSourceTimeRange: "single_message",
        helpful: body.rating === "helpful",
        providerType: attribution.providerType,
        promptVersion: attribution.promptVersion,
        targetType: "coach",
        reason: body.reason ?? null,
      },
      select: { id: true, createdAt: true },
    });

    await auditLog("insights.coach.message.feedback", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        feedbackId: created.id,
        messageId,
        rating: body.rating,
        providerType: attribution.providerType,
        promptVersion: attribution.promptVersion,
        metricSourceType: attribution.metricSourceType,
      },
    });

    annotate({
      action: { name: "insights.coach.message.feedback" },
      meta: {
        outcome: "created",
        rating: body.rating,
        providerType: attribution.providerType,
        promptVersion: attribution.promptVersion,
      },
    });

    return apiSuccess({ id: created.id, createdAt: created.createdAt }, 201);
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      annotate({
        action: { name: "insights.coach.message.feedback" },
        meta: { outcome: "already_rated" },
      });
      return apiError("already_rated", 409);
    }
    throw err;
  }
}

export const POST = apiHandler(handlePost);
