/**
 * v1.17.1 (#22) — medication-intake cross-device sync dispatcher tests.
 *
 * Exercises the server half of iOS issue #22:
 *   1. Silent background push to the user's OTHER devices (origin skip).
 *   2. APNs-only: the dispatch never reaches the dispatcher cascade, so
 *      Telegram / ntfy / Web Push senders are never imported here.
 *   3. Live Activity end push only when a `liveActivityPushToken` is stored.
 *   4. Bulk de-dup: one silent push per device per distinct slot.
 *   5. Explicit APNS-channel opt-out suppresses the fan-out.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const rawSendMock = vi.fn();
const loadConfigMock = vi.fn();
const recordPushAttemptMock = vi.fn();

vi.mock("@/lib/notifications/senders/apns", () => ({
  loadApnsConfig: () => loadConfigMock(),
  sendApnsRawPush: (...args: unknown[]) => rawSendMock(...args),
}));

vi.mock("@/lib/notifications/senders/push-attempt-record", () => ({
  recordPushAttempt: (...args: unknown[]) => recordPushAttemptMock(...args),
}));

vi.mock("@/lib/logging/context", () => ({
  getEvent: () => ({ addWarning: vi.fn(), addMeta: vi.fn() }),
}));

const deviceFindMany = vi.fn();
const channelFindUnique = vi.fn();
const deviceDeleteMany = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    device: {
      findMany: (...a: unknown[]) => deviceFindMany(...a),
      deleteMany: (...a: unknown[]) => deviceDeleteMany(...a),
    },
    notificationChannel: {
      findUnique: (...a: unknown[]) => channelFindUnique(...a),
    },
  },
}));

import {
  dispatchMedicationIntakeSync,
  dispatchMedicationIntakeSyncBulk,
} from "@/lib/notifications/medication-intake-sync";

const APNS_CONFIG = { bundleId: "test.healthlog.ios" };

beforeEach(() => {
  vi.clearAllMocks();
  loadConfigMock.mockReturnValue(APNS_CONFIG);
  channelFindUnique.mockResolvedValue({ enabled: true, preferences: [] });
  rawSendMock.mockResolvedValue({ ok: true, status: 200 });
  deviceDeleteMany.mockResolvedValue({ count: 0 });
});

describe("dispatchMedicationIntakeSync — origin skip + other-devices-only", () => {
  it("sends a silent background push to every device EXCEPT the origin", async () => {
    deviceFindMany.mockResolvedValue([
      {
        id: "d-origin",
        token: "origin-token",
        apnsToken: "aaaa1111",
        apnsEnvironment: "production",
        liveActivityPushToken: null,
      },
      {
        id: "d-other",
        token: "other-token",
        apnsToken: "bbbb2222",
        apnsEnvironment: "sandbox",
        liveActivityPushToken: null,
      },
    ]);

    await dispatchMedicationIntakeSync({
      userId: "u1",
      medicationId: "m1",
      scheduledFor: "2026-06-14T07:00:00.000Z",
      originDeviceToken: "origin-token",
    });

    // Exactly one push — to the non-origin device, silent background.
    expect(rawSendMock).toHaveBeenCalledTimes(1);
    const call = rawSendMock.mock.calls[0][0];
    expect(call.deviceToken).toBe("bbbb2222");
    expect(call.pushType).toBe("background");
    expect(call.priority).toBe(5);
    expect(call.payload).toMatchObject({
      aps: { "content-available": 1 },
      eventType: "MEDICATION_INTAKE_SYNC",
      medicationId: "m1",
      scheduledFor: "2026-06-14T07:00:00.000Z",
    });
    // No alert/sound/badge keys in the silent payload.
    expect(call.payload.aps.alert).toBeUndefined();
    expect(call.payload.aps.sound).toBeUndefined();
  });

  it("skips nothing when the origin token has no matching device (web caller)", async () => {
    deviceFindMany.mockResolvedValue([
      {
        id: "d1",
        token: "tok-1",
        apnsToken: "aaaa1111",
        apnsEnvironment: "sandbox",
        liveActivityPushToken: null,
      },
    ]);

    await dispatchMedicationIntakeSync({
      userId: "u1",
      medicationId: "m1",
      scheduledFor: "2026-06-14T07:00:00.000Z",
      originDeviceToken: "no-such-token",
    });

    expect(rawSendMock).toHaveBeenCalledTimes(1);
    expect(rawSendMock.mock.calls[0][0].deviceToken).toBe("aaaa1111");
  });

  it("records a skipped attempt when only the origin device exists", async () => {
    deviceFindMany.mockResolvedValue([
      {
        id: "d-origin",
        token: "origin-token",
        apnsToken: "aaaa1111",
        apnsEnvironment: "sandbox",
        liveActivityPushToken: null,
      },
    ]);

    await dispatchMedicationIntakeSync({
      userId: "u1",
      medicationId: "m1",
      scheduledFor: "2026-06-14T07:00:00.000Z",
      originDeviceToken: "origin-token",
    });

    expect(rawSendMock).not.toHaveBeenCalled();
    expect(recordPushAttemptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "APNS",
        eventType: "MEDICATION_INTAKE_SYNC",
        result: "skipped",
        reason: "intake_sync_no_other_devices",
      }),
    );
  });
});

describe("dispatchMedicationIntakeSync — Live Activity push", () => {
  it("sends a liveactivity end push only for devices with a stored token", async () => {
    deviceFindMany.mockResolvedValue([
      {
        id: "d1",
        token: "tok-1",
        apnsToken: "aaaa1111",
        apnsEnvironment: "production",
        liveActivityPushToken: "la-token-1",
      },
    ]);

    await dispatchMedicationIntakeSync({
      userId: "u1",
      medicationId: "m1",
      scheduledFor: "2026-06-14T07:00:00.000Z",
    });

    // One silent + one liveactivity push.
    expect(rawSendMock).toHaveBeenCalledTimes(2);
    const types = rawSendMock.mock.calls.map((c) => c[0].pushType);
    expect(types).toEqual(["background", "liveactivity"]);

    const la = rawSendMock.mock.calls.find(
      (c) => c[0].pushType === "liveactivity",
    )![0];
    expect(la.deviceToken).toBe("la-token-1");
    expect(la.topic).toBe("test.healthlog.ios.push-type.liveactivity");
    expect(la.payload.aps.event).toBe("end");
  });

  it("sends no liveactivity push when no token is stored", async () => {
    deviceFindMany.mockResolvedValue([
      {
        id: "d1",
        token: "tok-1",
        apnsToken: "aaaa1111",
        apnsEnvironment: "sandbox",
        liveActivityPushToken: null,
      },
    ]);

    await dispatchMedicationIntakeSync({
      userId: "u1",
      medicationId: "m1",
      scheduledFor: "2026-06-14T07:00:00.000Z",
    });

    expect(rawSendMock).toHaveBeenCalledTimes(1);
    expect(rawSendMock.mock.calls[0][0].pushType).toBe("background");
  });
});

describe("dispatchMedicationIntakeSync — gating", () => {
  it("no-ops silently when APNs is not configured", async () => {
    loadConfigMock.mockReturnValue(null);

    await dispatchMedicationIntakeSync({
      userId: "u1",
      medicationId: "m1",
      scheduledFor: "2026-06-14T07:00:00.000Z",
    });

    expect(deviceFindMany).not.toHaveBeenCalled();
    expect(rawSendMock).not.toHaveBeenCalled();
    expect(recordPushAttemptMock).not.toHaveBeenCalled();
  });

  it("suppresses the fan-out on an explicit APNS-channel opt-out", async () => {
    channelFindUnique.mockResolvedValue({
      enabled: true,
      preferences: [{ enabled: false }],
    });

    await dispatchMedicationIntakeSync({
      userId: "u1",
      medicationId: "m1",
      scheduledFor: "2026-06-14T07:00:00.000Z",
    });

    expect(deviceFindMany).not.toHaveBeenCalled();
    expect(rawSendMock).not.toHaveBeenCalled();
    expect(recordPushAttemptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        result: "skipped",
        reason: "intake_sync_disabled",
      }),
    );
  });

  it("suppresses when the APNS channel row itself is disabled", async () => {
    channelFindUnique.mockResolvedValue({ enabled: false, preferences: [] });

    await dispatchMedicationIntakeSync({
      userId: "u1",
      medicationId: "m1",
      scheduledFor: "2026-06-14T07:00:00.000Z",
    });

    expect(rawSendMock).not.toHaveBeenCalled();
  });

  it("reaps devices APNs reports as permanently dead", async () => {
    deviceFindMany.mockResolvedValue([
      {
        id: "d-dead",
        token: "tok-1",
        apnsToken: "aaaa1111",
        apnsEnvironment: "sandbox",
        liveActivityPushToken: null,
      },
    ]);
    rawSendMock.mockResolvedValue({
      ok: false,
      reason: "BadDeviceToken",
      shouldDisable: true,
    });

    await dispatchMedicationIntakeSync({
      userId: "u1",
      medicationId: "m1",
      scheduledFor: "2026-06-14T07:00:00.000Z",
    });

    expect(deviceDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["d-dead"] } },
    });
    expect(recordPushAttemptMock).toHaveBeenCalledWith(
      expect.objectContaining({ result: "error" }),
    );
  });
});

describe("dispatchMedicationIntakeSyncBulk — slot de-dup", () => {
  it("fires one silent push per device per DISTINCT slot, not per row", async () => {
    deviceFindMany.mockResolvedValue([
      {
        id: "d-other",
        token: "other-token",
        apnsToken: "bbbb2222",
        apnsEnvironment: "sandbox",
        liveActivityPushToken: null,
      },
    ]);

    await dispatchMedicationIntakeSyncBulk({
      userId: "u1",
      originDeviceToken: "origin-token",
      slots: [
        { medicationId: "m1", scheduledFor: "2026-06-14T07:00:00.000Z" },
        // duplicate of the first — must collapse
        { medicationId: "m1", scheduledFor: "2026-06-14T07:00:00.000Z" },
        { medicationId: "m1", scheduledFor: "2026-06-14T19:00:00.000Z" },
        { medicationId: "m2", scheduledFor: "2026-06-14T07:00:00.000Z" },
      ],
    });

    // 3 distinct slots × 1 recipient device = 3 silent pushes.
    expect(rawSendMock).toHaveBeenCalledTimes(3);
    const slots = rawSendMock.mock.calls.map((c) => [
      c[0].payload.medicationId,
      c[0].payload.scheduledFor,
    ]);
    expect(slots).toEqual([
      ["m1", "2026-06-14T07:00:00.000Z"],
      ["m1", "2026-06-14T19:00:00.000Z"],
      ["m2", "2026-06-14T07:00:00.000Z"],
    ]);
  });
});
