import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    userKnownDevice: {
      findUnique: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      count: vi.fn(),
    },
    user: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/geo", () => ({
  lookupIpLocation: vi.fn(async () => "Berlin, DE"),
  lookupIpAsn: vi.fn(() => null),
}));

vi.mock("@/lib/notifications/dispatcher", () => ({
  dispatchNotification: vi.fn().mockResolvedValue({ dispatched: true }),
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/i18n/server-translator", () => ({
  getServerTranslator: () => ({ t: (k: string) => k }),
}));

vi.mock("@/lib/logging/context", () => ({ getEvent: () => null }));

import { recordSignInDevice } from "../login-alert";
import { prisma } from "@/lib/db";
import { dispatchNotification } from "@/lib/notifications/dispatcher";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:120.0) Gecko/20100101 Firefox/120.0";

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    locale: "en",
  } as never);
  // Default: the user already has at least one established device, so a new
  // sighting is a genuine second-or-later device and may alert.
  vi.mocked(prisma.userKnownDevice.count).mockResolvedValue(1 as never);
});

describe("recordSignInDevice — new-device dedupe", () => {
  it("first sighting records the device AND fires one alert", async () => {
    vi.mocked(prisma.userKnownDevice.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.userKnownDevice.create).mockResolvedValue({} as never);

    const res = await recordSignInDevice({
      userId: "u1",
      ip: "203.0.113.9",
      userAgent: UA,
    });

    expect(res).toEqual({ known: false, alerted: true });
    expect(prisma.userKnownDevice.create).toHaveBeenCalledTimes(1);
    expect(dispatchNotification).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(dispatchNotification).mock.calls[0][0];
    expect(payload.eventType).toBe("SECURITY_ALERT");
    expect(payload.userId).toBe("u1");
  });

  it("first-ever device on an empty ledger records silently (baseline)", async () => {
    vi.mocked(prisma.userKnownDevice.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.userKnownDevice.count).mockResolvedValue(0 as never);
    vi.mocked(prisma.userKnownDevice.create).mockResolvedValue({} as never);

    const res = await recordSignInDevice({
      userId: "u1",
      ip: "203.0.113.9",
      userAgent: UA,
    });

    expect(res).toEqual({ known: false, alerted: false });
    expect(prisma.userKnownDevice.create).toHaveBeenCalledTimes(1);
    expect(dispatchNotification).not.toHaveBeenCalled();
  });

  it("second sighting of the same device is silent (no alert)", async () => {
    vi.mocked(prisma.userKnownDevice.findUnique).mockResolvedValue({
      id: "kd-1",
    } as never);
    vi.mocked(prisma.userKnownDevice.update).mockResolvedValue({} as never);

    const res = await recordSignInDevice({
      userId: "u1",
      ip: "203.0.113.9",
      userAgent: UA,
    });

    expect(res).toEqual({ known: true, alerted: false });
    expect(prisma.userKnownDevice.update).toHaveBeenCalledTimes(1);
    expect(prisma.userKnownDevice.create).not.toHaveBeenCalled();
    expect(dispatchNotification).not.toHaveBeenCalled();
  });

  it("records silently when alertOnNew is false (registration)", async () => {
    vi.mocked(prisma.userKnownDevice.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.userKnownDevice.create).mockResolvedValue({} as never);

    const res = await recordSignInDevice({
      userId: "u1",
      ip: "203.0.113.9",
      userAgent: UA,
      alertOnNew: false,
    });

    expect(res).toEqual({ known: false, alerted: false });
    expect(prisma.userKnownDevice.create).toHaveBeenCalledTimes(1);
    expect(dispatchNotification).not.toHaveBeenCalled();
  });

  it("a unique-index race on create does not double-alert", async () => {
    vi.mocked(prisma.userKnownDevice.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.userKnownDevice.create).mockRejectedValue(
      new Error("unique violation"),
    );

    const res = await recordSignInDevice({
      userId: "u1",
      ip: "203.0.113.9",
      userAgent: UA,
    });

    expect(res).toEqual({ known: true, alerted: false });
    expect(dispatchNotification).not.toHaveBeenCalled();
  });

  it("never persists the raw User-Agent — only the salted hash + coarse label", async () => {
    vi.mocked(prisma.userKnownDevice.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.userKnownDevice.create).mockResolvedValue({} as never);

    await recordSignInDevice({
      userId: "u1",
      ip: "203.0.113.9",
      userAgent: UA,
    });

    const data = vi.mocked(prisma.userKnownDevice.create).mock.calls[0][0].data;
    expect(data.deviceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(data)).not.toContain("Mozilla");
    expect(JSON.stringify(data)).not.toContain("203.0.113.9");
    // The coarse label is the family + platform descriptor.
    expect(data.label).toContain("Firefox on macOS");
  });
});
