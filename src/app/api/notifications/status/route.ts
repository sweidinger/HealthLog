import { NextRequest } from "next/server";
import { z } from "zod/v4";
import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess, apiError } from "@/lib/api-response";
import { CHANNEL_TYPE_LABELS } from "@/lib/notifications/types";
import type { ChannelType } from "@/lib/notifications/types";
import { reEnableChannel } from "@/lib/notifications/channel-state";

export const dynamic = "force-dynamic";

interface ChannelStatus {
  id: string;
  type: ChannelType;
  label: string;
  enabled: boolean;
  /**
   * "active"           — enabled & not in cooldown
   * "auto_disabled"    — enabled=false AND disabledReason is set
   * "manually_disabled"— enabled=false AND no disabledReason (the user
   *                      flipped a toggle, not the dispatcher)
   * "sending_paused"   — enabled=true but `nextRetryAt` is in the future
   */
  state: "active" | "auto_disabled" | "manually_disabled" | "sending_paused";
  disabledReason: string | null;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureReason: string | null;
  nextRetryAt: string | null;
}

function deriveState(channel: {
  enabled: boolean;
  disabledReason: string | null;
  nextRetryAt: Date | null;
}): ChannelStatus["state"] {
  if (!channel.enabled) {
    return channel.disabledReason ? "auto_disabled" : "manually_disabled";
  }
  if (channel.nextRetryAt && channel.nextRetryAt > new Date()) {
    return "sending_paused";
  }
  return "active";
}

/**
 * GET /api/notifications/status
 *
 * Returns the per-channel reliability state — what the Settings →
 * Notifications page paints into "Active / Auto-disabled / Sending paused"
 * badges + last-send / last-failure timestamps.
 */
export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "notifications.status.get" } });

  const channels = await prisma.notificationChannel.findMany({
    where: { userId: user.id },
    orderBy: { type: "asc" },
  });

  const data: ChannelStatus[] = channels.map((ch) => ({
    id: ch.id,
    type: ch.type as ChannelType,
    label: CHANNEL_TYPE_LABELS[ch.type as ChannelType] ?? ch.type,
    enabled: ch.enabled,
    state: deriveState(ch),
    disabledReason: ch.disabledReason,
    consecutiveFailures: ch.consecutiveFailures,
    lastSuccessAt: ch.lastSuccessAt?.toISOString() ?? null,
    lastFailureAt: ch.lastFailureAt?.toISOString() ?? null,
    lastFailureReason: ch.lastFailureReason,
    nextRetryAt: ch.nextRetryAt?.toISOString() ?? null,
  }));

  return apiSuccess({ channels: data });
});

const reEnableSchema = z.object({
  channelId: z.string().min(1).max(64),
});

/**
 * POST /api/notifications/status
 *
 * Re-enable an auto-disabled channel. Clears `disabledReason`,
 * `consecutiveFailures`, `nextRetryAt`, flips `enabled=true`, and writes
 * an audit-log entry (`notification.channel.re_enabled`). The Settings UI
 * follows up with a "Send test" call so the user gets immediate feedback
 * that the channel actually works again.
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "notifications.status.re_enable" } });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("Invalid JSON data", 422);
  }

  const parsed = reEnableSchema.safeParse(body);
  if (!parsed.success) return apiError("Invalid data", 422);

  const channel = await prisma.notificationChannel.findFirst({
    where: { id: parsed.data.channelId, userId: user.id },
  });
  if (!channel) return apiError("Channel not found", 404);

  await reEnableChannel({
    id: channel.id,
    userId: channel.userId,
    type: channel.type as ChannelType,
  });

  return apiSuccess({ ok: true });
});
