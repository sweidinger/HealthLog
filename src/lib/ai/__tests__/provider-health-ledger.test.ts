/**
 * v1.11.0 W1 — provider-health ledger.
 *
 * Two layers covered here:
 *   1. The Postgres ledger's classification + atomic-upsert SQL shape
 *      (mocked `prisma`) — an auth failure benches a provider for the
 *      long cooldown, a hard failure for the short one, and a success
 *      clears the negative cache. Multi-instance correctness is
 *      structural (single atomic `INSERT … ON CONFLICT … DO UPDATE`),
 *      so we assert the upsert is emitted rather than re-proving the
 *      DB's atomicity.
 *   2. The in-memory ledger's negative-cache semantics, which the
 *      runner tests reuse without standing up Postgres.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    providerHealth: { findMany: vi.fn() },
    $executeRaw: vi.fn(),
  },
}));

import { prisma } from "@/lib/db";
import {
  AUTH_FAILURE_COOLDOWN_MS,
  HARD_FAILURE_COOLDOWN_MS,
  HARD_FAILURE_SKIP_THRESHOLD,
  classifyFailure,
  createInMemoryProviderHealthLedger,
  findCredentialExpiredProviders,
  postgresProviderHealthLedger,
} from "../provider-health-ledger";

beforeEach(() => {
  vi.mocked(prisma.providerHealth.findMany).mockReset();
  vi.mocked(prisma.$executeRaw).mockReset();
  vi.mocked(prisma.$executeRaw).mockResolvedValue(1 as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("classifyFailure", () => {
  it("classifies 401 as auth_failed with the long cooldown", () => {
    expect(classifyFailure(401)).toEqual({
      result: "auth_failed",
      cooldownMs: AUTH_FAILURE_COOLDOWN_MS,
    });
  });

  it("classifies 403 as auth_failed", () => {
    expect(classifyFailure(403).result).toBe("auth_failed");
  });

  it("classifies 429 / 5xx / network as hard_failed with the short cooldown", () => {
    expect(classifyFailure(429)).toEqual({
      result: "hard_failed",
      cooldownMs: HARD_FAILURE_COOLDOWN_MS,
    });
    expect(classifyFailure(503).result).toBe("hard_failed");
    expect(classifyFailure(null).result).toBe("hard_failed");
  });
});

describe("postgresProviderHealthLedger", () => {
  it("getSkipHints benches an auth-failed provider in cooldown as credential_expired", async () => {
    const future = new Date(Date.now() + 60_000);
    vi.mocked(prisma.providerHealth.findMany).mockResolvedValue([
      {
        providerType: "codex",
        lastResult: "auth_failed",
        consecutiveFailures: 1,
        nextRetryAt: future,
      },
    ] as never);

    const hints = await postgresProviderHealthLedger.getSkipHints("u1");
    expect(hints.get("codex")?.reason).toBe("credential_expired");
  });

  it("getSkipHints does not bench an expired-cooldown row", async () => {
    const past = new Date(Date.now() - 60_000);
    vi.mocked(prisma.providerHealth.findMany).mockResolvedValue([
      {
        providerType: "codex",
        lastResult: "auth_failed",
        consecutiveFailures: 1,
        nextRetryAt: past,
      },
    ] as never);

    const hints = await postgresProviderHealthLedger.getSkipHints("u1");
    expect(hints.size).toBe(0);
  });

  it("getSkipHints benches a hard-failed provider only past the threshold", async () => {
    const future = new Date(Date.now() + 60_000);
    vi.mocked(prisma.providerHealth.findMany).mockResolvedValue([
      {
        providerType: "openai",
        lastResult: "hard_failed",
        consecutiveFailures: HARD_FAILURE_SKIP_THRESHOLD - 1,
        nextRetryAt: future,
      },
      {
        providerType: "anthropic",
        lastResult: "hard_failed",
        consecutiveFailures: HARD_FAILURE_SKIP_THRESHOLD,
        nextRetryAt: future,
      },
    ] as never);

    const hints = await postgresProviderHealthLedger.getSkipHints("u1");
    expect(hints.has("openai")).toBe(false);
    expect(hints.get("anthropic")?.reason).toBe("backoff");
  });

  it("getSkipHints fails open (empty) on a DB error", async () => {
    vi.mocked(prisma.providerHealth.findMany).mockRejectedValue(
      new Error("db down"),
    );
    const hints = await postgresProviderHealthLedger.getSkipHints("u1");
    expect(hints.size).toBe(0);
  });

  it("recordSuccess emits an atomic upsert and never throws on DB error", async () => {
    await postgresProviderHealthLedger.recordSuccess("u1", "codex");
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);

    vi.mocked(prisma.$executeRaw).mockRejectedValueOnce(new Error("boom"));
    await expect(
      postgresProviderHealthLedger.recordSuccess("u1", "codex"),
    ).resolves.toBeUndefined();
  });

  it("recordFailure emits an atomic upsert and never throws on DB error", async () => {
    await postgresProviderHealthLedger.recordFailure("u1", "codex", 401);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);

    vi.mocked(prisma.$executeRaw).mockRejectedValueOnce(new Error("boom"));
    await expect(
      postgresProviderHealthLedger.recordFailure("u1", "codex", 500),
    ).resolves.toBeUndefined();
  });
});

describe("findCredentialExpiredProviders", () => {
  it("returns the auth-failed providers still inside cooldown", async () => {
    vi.mocked(prisma.providerHealth.findMany).mockResolvedValue([
      { providerType: "codex" },
    ] as never);
    expect(await findCredentialExpiredProviders("u1")).toEqual(["codex"]);
  });

  it("fails open on a DB error", async () => {
    vi.mocked(prisma.providerHealth.findMany).mockRejectedValue(
      new Error("db down"),
    );
    expect(await findCredentialExpiredProviders("u1")).toEqual([]);
  });
});

describe("createInMemoryProviderHealthLedger", () => {
  it("benches an auth-failed provider immediately and clears on success", async () => {
    const ledger = createInMemoryProviderHealthLedger();
    await ledger.recordFailure("u1", "codex", 401);
    expect((await ledger.getSkipHints("u1")).get("codex")?.reason).toBe(
      "credential_expired",
    );

    await ledger.recordSuccess("u1", "codex");
    expect((await ledger.getSkipHints("u1")).size).toBe(0);
  });

  it("benches a hard-failed provider only after the consecutive threshold", async () => {
    const ledger = createInMemoryProviderHealthLedger();
    for (let i = 0; i < HARD_FAILURE_SKIP_THRESHOLD - 1; i += 1) {
      await ledger.recordFailure("u1", "openai", 503);
    }
    expect((await ledger.getSkipHints("u1")).has("openai")).toBe(false);

    await ledger.recordFailure("u1", "openai", 503);
    expect((await ledger.getSkipHints("u1")).get("openai")?.reason).toBe(
      "backoff",
    );
  });

  it("lets the negative cache lapse after the cooldown", async () => {
    vi.useFakeTimers();
    const ledger = createInMemoryProviderHealthLedger();
    await ledger.recordFailure("u1", "codex", 401);
    expect((await ledger.getSkipHints("u1")).size).toBe(1);

    vi.advanceTimersByTime(AUTH_FAILURE_COOLDOWN_MS + 1);
    expect((await ledger.getSkipHints("u1")).size).toBe(0);
  });
});
