import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    trustedDevice: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth/hmac", () => ({
  hashToken: (raw: string) => `h:${raw}`,
}));

vi.mock("@/lib/auth/secure-cookie", () => ({
  shouldEmitSecureCookie: () => true,
}));

let cookieValue: string | undefined;
const cookieStore = {
  get: vi.fn((name: string) =>
    name === "hl_trusted_device" && cookieValue !== undefined
      ? { value: cookieValue }
      : undefined,
  ),
  set: vi.fn(),
  delete: vi.fn(),
};
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => cookieStore),
}));

import {
  mintTrustedDevice,
  consumeTrustedDevice,
  revokeTrustedDevice,
  revokeAllTrustedDevices,
} from "../trusted-device";
import { prisma } from "@/lib/db";

beforeEach(() => {
  vi.clearAllMocks();
  cookieValue = undefined;
});

describe("mintTrustedDevice", () => {
  it("stores only the token hash and sets an httpOnly, secure cookie", async () => {
    vi.mocked(prisma.trustedDevice.create).mockResolvedValue({
      id: "td1",
      expiresAt: new Date(),
    } as never);

    await mintTrustedDevice("u1", "Firefox on macOS");

    const createArg = vi.mocked(prisma.trustedDevice.create).mock.calls[0][0];
    expect(createArg.data.userId).toBe("u1");
    expect(createArg.data.tokenHash.startsWith("h:")).toBe(true);
    // The raw token is never persisted — only the "h:" hash.
    expect(createArg.data.tokenHash).not.toBe(createArg.data.label);

    expect(cookieStore.set).toHaveBeenCalledWith(
      "hl_trusted_device",
      expect.any(String),
      expect.objectContaining({ httpOnly: true, secure: true }),
    );
  });
});

describe("consumeTrustedDevice", () => {
  it("returns false when no cookie is present", async () => {
    expect(await consumeTrustedDevice("u1")).toBe(false);
    expect(prisma.trustedDevice.findUnique).not.toHaveBeenCalled();
  });

  it("returns true for a live row owned by the user and bumps lastUsedAt", async () => {
    cookieValue = "tok";
    vi.mocked(prisma.trustedDevice.findUnique).mockResolvedValue({
      id: "td1",
      userId: "u1",
      expiresAt: new Date(Date.now() + 60_000),
    } as never);
    vi.mocked(prisma.trustedDevice.update).mockResolvedValue({} as never);

    expect(await consumeTrustedDevice("u1")).toBe(true);
    expect(prisma.trustedDevice.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "td1" } }),
    );
  });

  it("returns false when the row belongs to a different user", async () => {
    cookieValue = "tok";
    vi.mocked(prisma.trustedDevice.findUnique).mockResolvedValue({
      id: "td1",
      userId: "someone-else",
      expiresAt: new Date(Date.now() + 60_000),
    } as never);
    expect(await consumeTrustedDevice("u1")).toBe(false);
  });

  it("returns false and deletes the row when expired", async () => {
    cookieValue = "tok";
    vi.mocked(prisma.trustedDevice.findUnique).mockResolvedValue({
      id: "td1",
      userId: "u1",
      expiresAt: new Date(Date.now() - 1000),
    } as never);
    vi.mocked(prisma.trustedDevice.deleteMany).mockResolvedValue({
      count: 1,
    } as never);
    expect(await consumeTrustedDevice("u1")).toBe(false);
    expect(prisma.trustedDevice.deleteMany).toHaveBeenCalled();
    expect(cookieStore.delete).toHaveBeenCalledWith("hl_trusted_device");
  });
});

describe("revoke", () => {
  it("revokes a single device scoped to the user", async () => {
    vi.mocked(prisma.trustedDevice.findFirst).mockResolvedValue({
      id: "td1",
      tokenHash: "h:other",
    } as never);
    vi.mocked(prisma.trustedDevice.delete).mockResolvedValue({} as never);
    expect(await revokeTrustedDevice("u1", "td1")).toBe(true);
    expect(prisma.trustedDevice.delete).toHaveBeenCalledWith({
      where: { id: "td1" },
    });
  });

  it("returns false for a foreign id", async () => {
    vi.mocked(prisma.trustedDevice.findFirst).mockResolvedValue(null as never);
    expect(await revokeTrustedDevice("u1", "nope")).toBe(false);
    expect(prisma.trustedDevice.delete).not.toHaveBeenCalled();
  });

  it("revokeAll returns the deleted count", async () => {
    vi.mocked(prisma.trustedDevice.deleteMany).mockResolvedValue({
      count: 3,
    } as never);
    expect(await revokeAllTrustedDevices("u1")).toBe(3);
  });
});
