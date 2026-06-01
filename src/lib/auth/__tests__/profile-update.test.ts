import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

import { applyProfileUpdate } from "../profile-update";
import { prisma } from "@/lib/db";

const USER_ID = "user-1";

const STUB_USER = {
  id: USER_ID,
  username: "marc",
  displayName: null,
  email: null,
  role: "USER",
  heightCm: null,
  dateOfBirth: null,
  gender: null,
  timezone: "Europe/Berlin",
  locale: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.user.update).mockResolvedValue(STUB_USER as never);
});

describe("applyProfileUpdate timezone validation", () => {
  it("accepts a valid IANA zone", async () => {
    const result = await applyProfileUpdate(USER_ID, {
      timezone: "Europe/Berlin",
    });
    expect(result.ok).toBe(true);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
  });

  it("rejects an unknown zone with 422", async () => {
    const result = await applyProfileUpdate(USER_ID, {
      timezone: "Mars/Tharsis",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
      expect(result.message).toMatch(/Invalid IANA timezone/i);
    }
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("rejects an empty-string timezone", async () => {
    const result = await applyProfileUpdate(USER_ID, { timezone: "" });
    expect(result.ok).toBe(false);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("rejects an injection-shaped string", async () => {
    const result = await applyProfileUpdate(USER_ID, {
      timezone: "Europe/Berlin' OR 1=1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
    }
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

describe("applyProfileUpdate insurer IK number", () => {
  it("accepts a valid 9-digit IKNR and writes it field-by-field", async () => {
    const result = await applyProfileUpdate(USER_ID, {
      insurerIkNumber: "101234567",
    });
    expect(result.ok).toBe(true);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(prisma.user.update).mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(arg.data.insurerIkNumber).toBe("101234567");
  });

  it("trims surrounding whitespace before validating", async () => {
    const result = await applyProfileUpdate(USER_ID, {
      insurerIkNumber: "  101234567  ",
    });
    expect(result.ok).toBe(true);
    const arg = vi.mocked(prisma.user.update).mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(arg.data.insurerIkNumber).toBe("101234567");
  });

  it("maps an empty string to null (clears the field)", async () => {
    const result = await applyProfileUpdate(USER_ID, { insurerIkNumber: "" });
    expect(result.ok).toBe(true);
    const arg = vi.mocked(prisma.user.update).mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(arg.data.insurerIkNumber).toBeNull();
  });

  it("maps an explicit null to null", async () => {
    const result = await applyProfileUpdate(USER_ID, { insurerIkNumber: null });
    expect(result.ok).toBe(true);
    const arg = vi.mocked(prisma.user.update).mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(arg.data.insurerIkNumber).toBeNull();
  });

  it("leaves the field untouched when omitted", async () => {
    const result = await applyProfileUpdate(USER_ID, { fullName: "Someone" });
    expect(result.ok).toBe(true);
    const arg = vi.mocked(prisma.user.update).mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect("insurerIkNumber" in arg.data).toBe(false);
  });

  it("rejects a non-numeric IKNR with 422", async () => {
    const result = await applyProfileUpdate(USER_ID, {
      insurerIkNumber: "12345678X",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
      expect(result.message).toMatch(/IK number/i);
    }
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("rejects an IKNR that is not exactly 9 digits with 422", async () => {
    for (const bad of ["1234567", "1234567890"]) {
      vi.mocked(prisma.user.update).mockClear();
      const result = await applyProfileUpdate(USER_ID, {
        insurerIkNumber: bad,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.status).toBe(422);
      expect(prisma.user.update).not.toHaveBeenCalled();
    }
  });
});
