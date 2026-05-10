/**
 * GET /api/auth/me/devices
 *
 * v1.4.23 W4 F7b — list active devices for the current user. Drives the
 * settings → security → devices surface in the v1.5 iOS app and the
 * matching web view planned for a follow-up. The list ships
 * device-identifying metadata only (label, lastSeen, channels) — no
 * tokens, no APNs identifiers, no IPs.
 *
 * The "current device" marker is best-effort: the route inspects the
 * X-Device-Id header (which the native client always sends) and marks
 * the matching row with `isCurrent: true`. Browser callers don't have a
 * device row and therefore see `isCurrent: false` across the board.
 */
import { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";

interface DeviceDTO {
  id: string;
  label: string;
  platform: string;
  appVersion: string | null;
  locale: string | null;
  channels: Array<"web_push" | "apns">;
  lastSeenAt: string;
  createdAt: string;
  isCurrent: boolean;
}

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  const currentDeviceId = request.headers.get("x-device-id");

  const devices = await prisma.device.findMany({
    where: { userId: user.id },
    orderBy: { lastSeen: "desc" },
  });

  const result: DeviceDTO[] = devices.map((d) => {
    const channels: DeviceDTO["channels"] = [];
    // The legacy `token` column always carries the generic device
    // identifier — for v1.4.23 it doubles as the web-push channel
    // anchor when a VAPID subscription exists.
    if (d.token) channels.push("web_push");
    if (d.apnsToken) channels.push("apns");
    return {
      id: d.id,
      // Prefer the `model` field as the label; fall back to bundleId or
      // a generic platform string so the row never paints blank.
      label: d.model ?? d.bundleId ?? d.platform,
      platform: d.platform,
      appVersion: d.appVersion,
      locale: d.locale,
      channels,
      lastSeenAt: d.lastSeen.toISOString(),
      createdAt: d.createdAt.toISOString(),
      isCurrent: currentDeviceId !== null && d.id === currentDeviceId,
    };
  });

  annotate({
    action: { name: "auth.me.devices.list" },
    meta: { device_count: result.length },
  });

  return apiSuccess({ devices: result });
});
