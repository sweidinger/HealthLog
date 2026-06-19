/**
 * v1.17.1 (#22) — server-authoritative medication-intake cross-device sync.
 *
 * When a dose is logged / skipped / snoozed on ONE device, the user's
 * OTHER iOS devices need to reconcile: end or update the running Live
 * Activity, refresh the Home-Screen widget, drop the local reminder. The
 * server is the single source of truth for the intake state, so it owns
 * the fan-out. This module dispatches two APNs pushes per affected device:
 *
 *   1. A SILENT background push (`apns-push-type: background`,
 *      `content-available: 1`, no alert) carrying
 *      `{ eventType: "MEDICATION_INTAKE_SYNC", medicationId, scheduledFor }`.
 *      The iOS `NotificationService` consumes it and runs
 *      `BackgroundSyncCoordinator.runMedicationReconcile`.
 *
 *   2. A Live Activity end/update push (`apns-push-type: liveactivity`,
 *      topic `<bundle>.push-type.liveactivity`) to any device that has a
 *      stored `liveActivityPushToken`, so the lock-screen Activity ends
 *      immediately rather than waiting for the next background wake.
 *
 * APNs-ONLY by design. This event has no Telegram / ntfy / Web Push
 * semantics (those channels have no silent-sync transport), so it never
 * touches the dispatcher cascade — it talks straight to the APNs senders.
 *
 * Origin skip: the device that POSTed the mutation already knows the new
 * state and must not be woken. The caller passes the originating device's
 * registered `token` (the value the iOS client sends as `X-Device-Id`);
 * the matching `Device` row is excluded from both fan-outs. A web caller —
 * or a token with no matching row — skips nothing, which is harmless
 * (the iOS reconcile is idempotent).
 *
 * Best-effort: every failure is swallowed + annotated. A sync-push miss
 * must never fail the intake mutation that triggered it; the canonical
 * row is already persisted.
 */
import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";
import {
  loadApnsConfig,
  sendApnsRawPush,
} from "@/lib/notifications/senders/apns";
import { recordPushAttempt } from "@/lib/notifications/senders/push-attempt-record";
import { EVENT_DEFAULT_ENABLED } from "@/lib/notifications/types";

const EVENT_TYPE = "MEDICATION_INTAKE_SYNC";

export interface IntakeSyncInput {
  userId: string;
  medicationId: string;
  /** ISO-8601 scheduled-for instant of the affected dose slot. */
  scheduledFor: string;
  /**
   * The originating device's registered `Device.token` (sent by the iOS
   * client as the `X-Device-Id` header). The matching device is excluded
   * from the fan-out. `null` / unmatched skips nothing.
   */
  originDeviceToken?: string | null;
}

/**
 * Whether the user has explicitly opted the APNS channel out of
 * MEDICATION_INTAKE_SYNC. There is no second user-facing toggle — this is
 * coherence plumbing — but an explicit per-channel `NotificationPreference`
 * row (APNS / MEDICATION_INTAKE_SYNC / enabled=false) is still honoured so
 * an operator can disable the fan-out. Returns false (suppressed) only on
 * such an explicit opt-out.
 */
async function apnsSyncEnabled(userId: string): Promise<boolean> {
  const channel = await prisma.notificationChannel.findUnique({
    where: { userId_type: { userId, type: "APNS" } },
    select: {
      enabled: true,
      preferences: {
        where: { eventType: EVENT_TYPE },
        select: { enabled: true },
      },
    },
  });
  if (!channel || !channel.enabled) return false;
  const pref = channel.preferences[0];
  if (pref) return pref.enabled;
  return EVENT_DEFAULT_ENABLED.MEDICATION_INTAKE_SYNC;
}

/**
 * Dispatch the silent intake-sync push (+ Live Activity push) to the
 * user's other devices. De-duplicated to ONE silent push per device
 * regardless of how many intake rows the triggering mutation touched —
 * the caller passes a single `(medicationId, scheduledFor)` pair per
 * affected slot, but a bulk call should call this once with the affected
 * slot, not once per row (see `dispatchIntakeSyncBulk`).
 */
export async function dispatchMedicationIntakeSync(
  input: IntakeSyncInput,
): Promise<void> {
  try {
    const config = loadApnsConfig();
    if (!config) {
      // APNs not configured on this deployment — nothing to do. No ledger
      // row: the silent-sync channel is a no-op, not a delivery attempt.
      return;
    }

    if (!(await apnsSyncEnabled(input.userId))) {
      recordPushAttempt({
        userId: input.userId,
        channel: "APNS",
        eventType: EVENT_TYPE,
        result: "skipped",
        reason: "intake_sync_disabled",
      });
      return;
    }

    const devices = await prisma.device.findMany({
      where: { userId: input.userId, apnsToken: { not: null } },
      select: {
        id: true,
        token: true,
        apnsToken: true,
        apnsEnvironment: true,
        liveActivityPushToken: true,
      },
    });

    // Exclude the originating device — it already holds the new state.
    const recipients = devices.filter(
      (d) => !input.originDeviceToken || d.token !== input.originDeviceToken,
    );

    if (recipients.length === 0) {
      recordPushAttempt({
        userId: input.userId,
        channel: "APNS",
        eventType: EVENT_TYPE,
        result: "skipped",
        reason: "intake_sync_no_other_devices",
      });
      return;
    }

    const silentPayload = {
      aps: { "content-available": 1 },
      eventType: EVENT_TYPE,
      medicationId: input.medicationId,
      scheduledFor: input.scheduledFor,
    };

    let anySuccess = false;
    const deadDeviceIds: string[] = [];
    let lastFailureReason: string | undefined;

    for (const device of recipients) {
      if (!device.apnsToken) continue;
      const environment: "sandbox" | "production" =
        device.apnsEnvironment === "production" ? "production" : "sandbox";

      // 1) Silent background reconcile push — one per device.
      const silent = await sendApnsRawPush({
        deviceToken: device.apnsToken,
        environment,
        pushType: "background",
        payload: silentPayload,
        priority: 5,
      });
      if (silent.ok) {
        anySuccess = true;
      } else {
        lastFailureReason = silent.reason;
        if (silent.shouldDisable) deadDeviceIds.push(device.id);
      }

      // 2) Live Activity end/update push — only when a token is stored.
      if (device.liveActivityPushToken) {
        await sendLiveActivityEnd({
          token: device.liveActivityPushToken,
          environment,
          bundleId: config.bundleId,
          medicationId: input.medicationId,
          scheduledFor: input.scheduledFor,
        });
      }
    }

    // Reap devices APNs reported as permanently dead on the silent send.
    if (deadDeviceIds.length > 0) {
      await prisma.device
        .deleteMany({ where: { id: { in: deadDeviceIds } } })
        .catch(() => {
          /* best-effort cleanup */
        });
    }

    recordPushAttempt({
      userId: input.userId,
      channel: "APNS",
      eventType: EVENT_TYPE,
      result: anySuccess ? "ok" : "error",
      reason: anySuccess ? null : (lastFailureReason ?? "intake_sync_failed"),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    getEvent()?.addWarning(
      `medication_intake_sync_dispatch_failed: ${message}`,
    );
  }
}

/**
 * Bulk-call entry point: de-duplicates the affected slots so the fan-out
 * fires ONE silent push per device per distinct `(medicationId,
 * scheduledFor)` slot the batch touched — not one per intake row. iOS
 * coalesces multiple background wakes anyway, but de-duping here keeps the
 * APNs quota proportional to slots, not to row count.
 */
export async function dispatchMedicationIntakeSyncBulk(args: {
  userId: string;
  slots: Array<{ medicationId: string; scheduledFor: string }>;
  originDeviceToken?: string | null;
}): Promise<void> {
  const seen = new Set<string>();
  const distinct: Array<{ medicationId: string; scheduledFor: string }> = [];
  for (const slot of args.slots) {
    const key = `${slot.medicationId}|${slot.scheduledFor}`;
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push(slot);
  }
  for (const slot of distinct) {
    await dispatchMedicationIntakeSync({
      userId: args.userId,
      medicationId: slot.medicationId,
      scheduledFor: slot.scheduledFor,
      originDeviceToken: args.originDeviceToken,
    });
  }
}

/**
 * Push an ActivityKit `end` event to a running Live Activity. The Activity
 * push topic is the app bundle id suffixed with `.push-type.liveactivity`;
 * the body carries the ActivityKit envelope (`event: "end"`, a timestamp,
 * an empty content-state). Best-effort: a failure is annotated, never
 * thrown.
 */
async function sendLiveActivityEnd(args: {
  token: string;
  environment: "sandbox" | "production";
  bundleId: string;
  medicationId: string;
  scheduledFor: string;
}): Promise<void> {
  try {
    const result = await sendApnsRawPush({
      deviceToken: args.token,
      environment: args.environment,
      pushType: "liveactivity",
      topic: `${args.bundleId}.push-type.liveactivity`,
      priority: 10,
      payload: {
        aps: {
          timestamp: Math.floor(Date.now() / 1000),
          event: "end",
          "content-state": {},
          // Dismiss the ended Activity from the lock screen promptly.
          "dismissal-date": Math.floor(Date.now() / 1000),
        },
        medicationId: args.medicationId,
        scheduledFor: args.scheduledFor,
      },
    });
    if (!result.ok) {
      getEvent()?.addMeta(
        "medication_intake_sync_liveactivity_failed",
        result.reason ?? "unknown",
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    getEvent()?.addWarning(
      `medication_intake_sync_liveactivity_threw: ${message}`,
    );
  }
}
