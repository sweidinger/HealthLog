import { describe, it, expect, vi, beforeEach } from "vitest";

import { runMorningDigestRefresh } from "../morning-digest-refresh";
import type { GenerateOutcome } from "@/lib/insights/comprehensive-generate";

const LOCAL_DATE = "2026-07-16";

function makePrisma(
  user: { locale: string | null; morningDigestRefreshedOn: string | null } | null,
) {
  const updateMock = vi.fn(async () => ({}));
  const prisma = {
    user: {
      findUnique: vi.fn(async () => user),
      update: updateMock,
    },
  };
  return { prisma, updateMock };
}

describe("runMorningDigestRefresh", () => {
  const retryMock = vi.fn(async () => {});

  beforeEach(() => {
    retryMock.mockReset();
  });

  it("regenerates and stamps the marker → finalises the day", async () => {
    const { prisma, updateMock } = makePrisma({
      locale: "en",
      morningDigestRefreshedOn: null,
    });
    const generate = vi.fn(
      async (): Promise<GenerateOutcome> => ({
        status: "generated",
        providerType: "mock",
      }),
    );

    const result = await runMorningDigestRefresh(
      prisma as never,
      { userId: "u1", localDate: LOCAL_DATE },
      { generate, enqueueRetry: retryMock },
    );

    expect(generate).toHaveBeenCalledWith("u1", { locale: "en", force: true });
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { morningDigestRefreshedOn: LOCAL_DATE },
    });
    expect(result.status).toBe("finalised");
    expect(retryMock).not.toHaveBeenCalled();
  });

  it("finalises on an `unchanged` regen (content-hash no-op is still fresh)", async () => {
    const { prisma, updateMock } = makePrisma({
      locale: "de",
      morningDigestRefreshedOn: null,
    });
    const generate = vi.fn(
      async (): Promise<GenerateOutcome> => ({ status: "unchanged" }),
    );

    const result = await runMorningDigestRefresh(
      prisma as never,
      { userId: "u1", localDate: LOCAL_DATE },
      { generate, enqueueRetry: retryMock },
    );

    expect(generate).toHaveBeenCalledWith("u1", { locale: "de", force: true });
    expect(updateMock).toHaveBeenCalled();
    expect(result).toEqual({ status: "finalised", comprehensive: "unchanged" });
  });

  it("finalises a keyless user (`skipped` no-provider) — nothing to wait for", async () => {
    const { prisma, updateMock } = makePrisma({
      locale: "en",
      morningDigestRefreshedOn: null,
    });
    const generate = vi.fn(
      async (): Promise<GenerateOutcome> => ({
        status: "skipped",
        reason: "no-provider",
      }),
    );

    const result = await runMorningDigestRefresh(
      prisma as never,
      { userId: "u1", localDate: LOCAL_DATE },
      { generate, enqueueRetry: retryMock },
    );

    expect(updateMock).toHaveBeenCalled();
    expect(result.status).toBe("finalised");
  });

  it("is idempotent: a second run for the same morning no-ops via the marker", async () => {
    const { prisma, updateMock } = makePrisma({
      locale: "en",
      morningDigestRefreshedOn: LOCAL_DATE,
    });
    const generate = vi.fn(
      async (): Promise<GenerateOutcome> => ({
        status: "generated",
        providerType: "mock",
      }),
    );

    const result = await runMorningDigestRefresh(
      prisma as never,
      { userId: "u1", localDate: LOCAL_DATE },
      { generate, enqueueRetry: retryMock },
    );

    expect(generate).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(result.status).toBe("already-final");
  });

  it("leaves the day provisional on a hard generation failure and hands off to the retry machinery", async () => {
    const { prisma, updateMock } = makePrisma({
      locale: "en",
      morningDigestRefreshedOn: null,
    });
    const generate = vi.fn(
      async (): Promise<GenerateOutcome> => ({
        status: "failed",
        reason: "provider-timeout",
      }),
    );

    const result = await runMorningDigestRefresh(
      prisma as never,
      { userId: "u1", localDate: LOCAL_DATE },
      { generate, enqueueRetry: retryMock },
    );

    expect(updateMock).not.toHaveBeenCalled();
    expect(retryMock).toHaveBeenCalledWith({ userId: "u1", locale: "en" });
    expect(result.status).toBe("failed");
  });

  it("reports missing-user when the row is gone", async () => {
    const { prisma, updateMock } = makePrisma(null);
    const generate = vi.fn(
      async (): Promise<GenerateOutcome> => ({ status: "unchanged" }),
    );

    const result = await runMorningDigestRefresh(
      prisma as never,
      { userId: "ghost", localDate: LOCAL_DATE },
      { generate, enqueueRetry: retryMock },
    );

    expect(generate).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(result.status).toBe("missing-user");
  });
});
