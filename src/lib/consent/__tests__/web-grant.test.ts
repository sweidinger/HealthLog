import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    consentReceipt: {
      create: vi.fn(),
      findFirst: vi.fn(),
    },
  },
}));

import { prisma } from "@/lib/db";
import { ensureWebAiConsentReceipt } from "../web-grant";

beforeEach(() => {
  vi.resetAllMocks();
});

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "rcpt-web-1",
    userId: "user-1",
    kind: "ai_full",
    artefact: "{}",
    signedAt: new Date("2026-06-14T10:00:00.000Z"),
    revokedAt: null,
    createdAt: new Date("2026-06-14T10:00:01.000Z"),
    ...overrides,
  };
}

describe("ensureWebAiConsentReceipt", () => {
  it("mints an ai_full receipt when none is active", async () => {
    vi.mocked(prisma.consentReceipt.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.consentReceipt.create).mockResolvedValue(row() as never);

    const now = new Date("2026-06-14T10:00:00.000Z");
    const result = await ensureWebAiConsentReceipt("user-1", now);

    expect(result.minted).toBe(true);
    // Reads the active master grant first.
    expect(prisma.consentReceipt.findFirst).toHaveBeenCalledWith({
      where: { userId: "user-1", kind: "ai_full", revokedAt: null },
      orderBy: { createdAt: "desc" },
    });
    // Mints ai_full with a web-source artefact + the supplied timestamp.
    const createArg = vi.mocked(prisma.consentReceipt.create).mock.calls[0][0];
    expect(createArg.data.userId).toBe("user-1");
    expect(createArg.data.kind).toBe("ai_full");
    expect(createArg.data.signedAt).toEqual(now);
    const artefact = JSON.parse(createArg.data.artefact as string);
    expect(artefact.source).toBe("web");
    expect(artefact.kind).toBe("ai_full");
  });

  it("is a no-op when an active ai_full receipt already exists", async () => {
    vi.mocked(prisma.consentReceipt.findFirst).mockResolvedValue(row() as never);

    const result = await ensureWebAiConsentReceipt("user-1");

    expect(result.minted).toBe(false);
    expect(prisma.consentReceipt.create).not.toHaveBeenCalled();
  });
});
