/**
 * v1.18.6 — safety-floor escalation push.
 *
 * Pins: null decision = no-op; a confirmed breach dispatches an URGENT
 * SYSTEM_ALERT; asymptomatic → Doctor copy, symptom-coupled → Emergency copy;
 * a recent ledger row de-dupes by reason; failures never throw; the ledger
 * anchor is stamped before dispatch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findFirstMock = vi.fn();
const createMock = vi.fn();
const dispatchMock = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    pushAttempt: {
      findFirst: (...a: unknown[]) => findFirstMock(...a),
      create: (...a: unknown[]) => createMock(...a),
    },
  },
}));

vi.mock("@/lib/logging/context", () => ({
  getEvent: () => ({ addMeta: vi.fn(), addWarning: vi.fn() }),
}));

vi.mock("@/lib/notifications/dispatch-localised", () => ({
  dispatchLocalisedNotification: (...a: unknown[]) => dispatchMock(...a),
}));

import { notifySafetyFloor } from "../safety-floor-notify";
import type { SafetyFloorDecision } from "../safety-floors";

const bpHigh: SafetyFloorDecision = {
  kind: "BLOOD_PRESSURE",
  reason: "bp_hypertensive",
  tier: "severe",
  symptomCoupled: false,
  value: 188,
  diastolic: 122,
};
const glucoseLowSymptomatic: SafetyFloorDecision = {
  kind: "GLUCOSE",
  reason: "glucose_hypo_severe",
  tier: "severe",
  symptomCoupled: true,
  value: 48,
  diastolic: null,
};

beforeEach(() => {
  findFirstMock.mockReset().mockResolvedValue(null);
  createMock.mockReset().mockResolvedValue({});
  dispatchMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => vi.clearAllMocks());

describe("notifySafetyFloor", () => {
  it("no-op when the decision is null", async () => {
    await notifySafetyFloor({ userId: "u1", decision: null });
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it("dispatches an URGENT SYSTEM_ALERT with the asymptomatic Doctor copy", async () => {
    await notifySafetyFloor({ userId: "u1", decision: bpHigh });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const opts = dispatchMock.mock.calls[0][0];
    expect(opts.urgent).toBe(true);
    expect(opts.eventType).toBe("SYSTEM_ALERT");
    expect(opts.userId).toBe("u1");
    expect(opts.titleKey).toBe("safety.floor.bpHighTitle");
    expect(opts.messageKey).toBe("safety.floor.bpHighDoctor");
    expect(opts.params).toEqual({ systolic: 188, diastolic: 122 });
  });

  it("uses the Emergency copy variant when symptom-coupled", async () => {
    await notifySafetyFloor({ userId: "u1", decision: glucoseLowSymptomatic });
    const opts = dispatchMock.mock.calls[0][0];
    expect(opts.messageKey).toBe("safety.floor.glucoseLowSevereEmergency");
    expect(opts.titleKey).toBe("safety.floor.glucoseLowSevereTitle");
    expect(opts.params).toEqual({ value: 48 });
  });

  it("de-dupes by reason when a recent ledger row exists", async () => {
    findFirstMock.mockResolvedValueOnce({ id: "prior" });
    await notifySafetyFloor({ userId: "u1", decision: bpHigh });
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("stamps the ledger anchor (keyed by reason) before dispatching", async () => {
    await notifySafetyFloor({ userId: "u9", decision: bpHigh });
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0][0].data.reason).toContain(
      "bp_hypertensive",
    );
    expect(createMock.mock.calls[0][0].data.eventType).toBe("SYSTEM_ALERT");
  });

  it("never throws when dispatch fails", async () => {
    dispatchMock.mockRejectedValueOnce(new Error("boom"));
    await expect(
      notifySafetyFloor({ userId: "u1", decision: bpHigh }),
    ).resolves.toBeUndefined();
  });
});
