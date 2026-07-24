/**
 * v1.18.4 — Web Push "clear" for a logged medication dose.
 *
 * A self-hoster on the installed PWA with no Apple Developer account has no
 * Live Activity / Home-Screen widget to reconcile when a dose is logged on
 * another tab/device. The native path (`queueMedicationIntakeSync`) ends
 * the Live Activity over APNs; this module is the PWA-only equivalent: it
 * pushes a `{ type: "clear", tag }` payload to the user's Web Push
 * subscriptions so the service worker closes the still-pending dose-due
 * reminder for that exact slot (same stable tag the reminder used) and
 * refreshes the app badge.
 *
 * Targeted + best-effort: it talks straight to the user's PushSubscription
 * rows (not the full dispatcher cascade) because a clear has no Telegram /
 * ntfy / email analogue — those channels can't retract a sent message. Every
 * failure is swallowed + annotated; a clear miss never fails the intake
 * mutation that triggered it. Expired (410/404) subscriptions are reaped, the
 * same as the alert sender.
 */
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { getVapidConfig } from "@/lib/notifications/vapid-config";
import { getEvent } from "@/lib/logging/context";
import { isPublicUrl } from "@/lib/validations/notifications";
import { safeFetch } from "@/lib/safe-fetch";
import { medicationDoseTag } from "@/lib/notifications/dose-tag";

export interface WebClearInput {
  userId: string;
  medicationId: string;
  /** ISO-8601 scheduled-for instant of the affected dose slot. */
  scheduledFor: string;
  /**
   * Server-authoritative count of the user's still-outstanding doses after
   * this mutation. The SW reflects it via `navigator.setAppBadge`. Omit to
   * leave the badge untouched.
   */
  badgeCount?: number;
}

/**
 * Send a `type:"clear"` web push that closes the pending reminder for one
 * dose slot and updates the app badge. Best-effort, fire-and-forget safe.
 */
export async function dispatchMedicationIntakeWebClear(
  input: WebClearInput,
): Promise<void> {
  try {
    const config = await getVapidConfig();
    if (!config) return; // VAPID not configured — nothing to clear.

    const subscriptions = await prisma.pushSubscription.findMany({
      where: { userId: input.userId },
    });
    if (!subscriptions.length) return;

    const webpush = await import("web-push");
    webpush.setVapidDetails(
      config.subject,
      config.publicKey,
      config.privateKey,
    );

    const badgeCount =
      typeof input.badgeCount === "number" && Number.isFinite(input.badgeCount)
        ? Math.max(0, Math.trunc(input.badgeCount))
        : undefined;

    const clearPayload = JSON.stringify({
      type: "clear",
      tag: medicationDoseTag(input.medicationId, input.scheduledFor),
      ...(badgeCount !== undefined ? { badge: badgeCount } : {}),
    });

    const expiredIds: string[] = [];
    for (const sub of subscriptions) {
      try {
        if (!isPublicUrl(sub.endpoint)) {
          expiredIds.push(sub.id);
          continue;
        }
        const p256dh = decrypt(sub.p256dh);
        const auth = decrypt(sub.auth);
        // Same transport swap as the main sender: sign + encrypt via
        // `generateRequestDetails`, then dial through `safeFetch` with the
        // pinned dispatcher so a DNS rebind between the literal
        // `isPublicUrl` check above and the connect cannot reach a private
        // address (issue #217).
        const details = webpush.generateRequestDetails(
          { endpoint: sub.endpoint, keys: { p256dh, auth } },
          clearPayload,
        ) as {
          endpoint: string;
          method: string;
          headers: Record<string, string>;
          body: Buffer | string | null;
        };
        const clearRes = await safeFetch(
          details.endpoint,
          {
            method: details.method,
            headers: details.headers,
            body: (details.body ?? undefined) as BodyInit | undefined,
          },
          { requirePublicHost: true },
        );
        if (clearRes.status < 200 || clearRes.status >= 300) {
          throw Object.assign(
            new Error(`Web Push clear responded ${clearRes.status}`),
            { statusCode: clearRes.status },
          );
        }
      } catch (err: unknown) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 410 || status === 404) expiredIds.push(sub.id);
        // Soft errors on a best-effort clear are ignored — the next reminder
        // tick or badge refresh self-corrects.
      }
    }

    if (expiredIds.length > 0) {
      await prisma.pushSubscription
        .deleteMany({ where: { id: { in: expiredIds } } })
        .catch(() => {
          /* best-effort cleanup */
        });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    getEvent()?.addWarning(`medication_intake_web_clear_failed: ${message}`);
  }
}

/**
 * Bulk entry point — de-duplicates affected slots so one clear fires per
 * distinct `(medicationId, scheduledFor)` slot a batch touched. The badge
 * count is the same post-mutation outstanding total for every slot, so it is
 * passed through unchanged.
 */
export async function dispatchMedicationIntakeWebClearBulk(args: {
  userId: string;
  slots: Array<{ medicationId: string; scheduledFor: string }>;
  badgeCount?: number;
}): Promise<void> {
  const seen = new Set<string>();
  for (const slot of args.slots) {
    const key = `${slot.medicationId}|${slot.scheduledFor}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await dispatchMedicationIntakeWebClear({
      userId: args.userId,
      medicationId: slot.medicationId,
      scheduledFor: slot.scheduledFor,
      badgeCount: args.badgeCount,
    });
  }
}
