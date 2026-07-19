/**
 * Degradation is the headline, not the AI.
 *
 * The milestone's actual moment is the STATE CHANGE: something landed, the
 * record now reads differently, and the open dashboard shows it. The generated
 * sentence is garnish on top of that. This file exists to keep those two
 * things separable forever — because the tempting future refactor is to treat
 * the line as the feature and let a provider-less install fall off the surface
 * with it.
 *
 * So: for every reason a line can fail to exist — no provider, no consent, an
 * exhausted budget, a dead provider, an unusable output — the row must stay
 * line-less WITHOUT spending anything it did not reconcile, and the digest must
 * still surface the chip. The last assertion of each case is the one that
 * matters: `justIn` survives.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { getServerTranslator } from "@/lib/i18n/server-translator";
import { buildDailyDigest, type DailyDigestInput } from "@/lib/daily/digest";

const findUnique = vi.fn();
const update = vi.fn();
const userFindUnique = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    arrivalReaction: {
      findUnique: (...a: unknown[]) => findUnique(...a),
      update: (...a: unknown[]) => update(...a),
    },
    user: { findUnique: (...a: unknown[]) => userFindUnique(...a) },
  },
}));

const resolveProviderChain = vi.fn();
vi.mock("@/lib/ai/provider", () => ({
  resolveProviderChain: (...a: unknown[]) => resolveProviderChain(...a),
}));

const chainRequiresServerManagedConsent = vi.fn();
const hasActiveConsentForSurface = vi.fn();
vi.mock("@/lib/ai/consent-guard", () => ({
  chainRequiresServerManagedConsent: (...a: unknown[]) =>
    chainRequiresServerManagedConsent(...a),
  hasActiveConsentForSurface: (...a: unknown[]) =>
    hasActiveConsentForSurface(...a),
}));

const reserveBudget = vi.fn();
const reconcileSpend = vi.fn();
vi.mock("@/lib/ai/coach/budget", () => ({
  buildDateKey: () => "2026-07-16",
  reserveBudget: (...a: unknown[]) => reserveBudget(...a),
  reconcileSpend: (...a: unknown[]) => reconcileSpend(...a),
  resolveDailyCap: () => 200_000,
}));

const loadDailyDigest = vi.fn();
vi.mock("@/lib/daily/load-digest", () => ({
  loadDailyDigest: (...a: unknown[]) => loadDailyDigest(...a),
}));

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/jobs/reminder/shared", () => ({ workerLog: vi.fn() }));
vi.mock("@/lib/ai/coach/bytes-codec", () => ({
  encryptToBytes: (s: string) => new TextEncoder().encode(s),
}));

import { runReactionLine } from "@/lib/jobs/reaction-line";

const JOB = {
  userId: "u1",
  kind: "sleep_night" as const,
  localDate: "2026-07-16",
};

const t = getServerTranslator("en").t;
const NOW = new Date("2026-07-16T09:00:00.000Z");

/**
 * The digest a user sees when the line was never written. Built from the REAL
 * composer, not a hand-shaped object, so this asserts the actual degrade path
 * rather than a fixture that agrees with the test.
 */
function degradedDigest() {
  const input: DailyDigestInput = {
    now: NOW,
    modules: {},
    score: { value: 82, band: "good", delta: 3 },
    briefing: null,
    medsToday: {
      activeCount: 0,
      scheduledToday: 0,
      takenToday: 0,
      skippedToday: 0,
      nextDueAt: null,
      nextDueOverdue: false,
      nextDueMedicationName: null,
      nextDueMedicationId: null,
    },
    sleepLastSeenDaysAgo: 0,
    morningRefreshedToday: true,
    syncIssues: [],
    preventiveDue: [],
    coachPlans: [],
    tensionWindow: null,
    todayLocalDate: "2026-07-16",
    dismissedItemKeys: new Set<string>(),
    // The marker exists; the line does not. This is the provider-less shape.
    arrivals: [
      {
        kind: "sleep_night",
        occurredAt: new Date(NOW.getTime() - 60_000),
        line: null,
      },
    ],
  };
  return buildDailyDigest(input, t);
}

/** Every degrade case must leave the surface fully functional. */
function expectSurfaceStillWorks() {
  const digest = degradedDigest();
  // The chip — the moment itself — is untouched by the missing sentence.
  expect(digest.justIn).toEqual({
    kind: "sleep_night",
    at: new Date(NOW.getTime() - 60_000).toISOString(),
  });
  // The provisional→final flip is likewise unaffected.
  expect(digest.phase).toBe("final");
  expect(digest.sleepPending).toBe(false);
  // And the hero still has a lead to render: the deterministic floor.
  expect(digest.reactionLine).toBeNull();
  expect(digest.line.length).toBeGreaterThan(0);
}

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue({ id: "r1", generatedAt: null });
  userFindUnique.mockResolvedValue({ id: "u1", locale: "en", timezone: "UTC" });
  chainRequiresServerManagedConsent.mockReturnValue(false);
  hasActiveConsentForSurface.mockResolvedValue(true);
  reserveBudget.mockResolvedValue({
    allowed: true,
    reserved: 1_400,
    totalAfter: 1_400,
  });
  reconcileSpend.mockResolvedValue(undefined);
  loadDailyDigest.mockResolvedValue({
    score: { value: 82, band: "good", delta: 3 },
    topSignal: null,
    briefingLead: "Steady week.",
  });
});

describe("reaction line — degradation", () => {
  it("no provider: writes nothing, spends nothing, surface intact", async () => {
    resolveProviderChain.mockResolvedValue([]);

    const outcome = await runReactionLine(JOB);

    expect(outcome).toEqual({ status: "skipped", reason: "no_provider" });
    expect(reserveBudget).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expectSurfaceStillWorks();
  });

  it("no consent on a server-managed chain: refuses before reserving", async () => {
    resolveProviderChain.mockResolvedValue([
      { providerType: "admin-openai", instance: {} },
    ]);
    chainRequiresServerManagedConsent.mockReturnValue(true);
    hasActiveConsentForSurface.mockResolvedValue(false);

    const outcome = await runReactionLine(JOB);

    expect(outcome).toEqual({ status: "skipped", reason: "consent_required" });
    // A user without a receipt must not spend a token OR a ledger slot.
    expect(reserveBudget).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expectSurfaceStillWorks();
  });

  it("exhausted budget: refuses, writes nothing, surface intact", async () => {
    resolveProviderChain.mockResolvedValue([
      { providerType: "openai", instance: {} },
    ]);
    reserveBudget.mockResolvedValue({
      allowed: false,
      reserved: 1_400,
      totalAfter: 999_999,
    });

    const outcome = await runReactionLine(JOB);

    expect(outcome).toEqual({ status: "skipped", reason: "budget_exceeded" });
    expect(update).not.toHaveBeenCalled();
    expectSurfaceStillWorks();
  });

  it("provider throws: reconciles the reservation to zero and degrades", async () => {
    resolveProviderChain.mockResolvedValue([
      {
        providerType: "openai",
        instance: {
          generateCompletion: vi.fn().mockRejectedValue(new Error("timeout")),
        },
      },
    ]);

    const outcome = await runReactionLine(JOB);

    expect(outcome).toEqual({ status: "skipped", reason: "provider_failed" });
    // The failure path MUST reconcile — an abandoned reservation is a silent
    // over-charge against the user's own daily ceiling.
    expect(reconcileSpend).toHaveBeenCalledWith("u1", 1_400, 0, "2026-07-16");
    expect(update).not.toHaveBeenCalled();
    expectSurfaceStillWorks();
  });

  it("unusable output: reconciles the ACTUAL spend and still writes no line", async () => {
    resolveProviderChain.mockResolvedValue([
      {
        providerType: "openai",
        instance: {
          generateCompletion: vi.fn().mockResolvedValue({
            content: "   ",
            tokensUsed: 900,
            cachedInputTokens: 0,
          }),
        },
      },
    ]);

    const outcome = await runReactionLine(JOB);

    expect(outcome).toEqual({ status: "skipped", reason: "unusable_output" });
    // The call happened, so the real tokens are billed — not zero.
    expect(reconcileSpend).toHaveBeenCalledWith(
      "u1",
      1_400,
      900,
      "2026-07-16",
      0,
    );
    expect(update).not.toHaveBeenCalled();
    expectSurfaceStillWorks();
  });

  it("a committed line is never regenerated — the unique row is the throttle", async () => {
    findUnique.mockResolvedValue({ id: "r1", generatedAt: new Date() });
    resolveProviderChain.mockResolvedValue([
      { providerType: "openai", instance: {} },
    ]);

    const outcome = await runReactionLine(JOB);

    expect(outcome).toEqual({ status: "skipped", reason: "already_generated" });
    // The refusal happens before the chain is even resolved: there is no code
    // path to a second provider call for this kind today.
    expect(resolveProviderChain).not.toHaveBeenCalled();
    expect(reserveBudget).not.toHaveBeenCalled();
  });

  it("the happy path does write, so the degrade cases above are not vacuous", async () => {
    resolveProviderChain.mockResolvedValue([
      {
        providerType: "openai",
        instance: {
          generateCompletion: vi.fn().mockResolvedValue({
            content: "A solid night, deeper than your recent stretch.",
            tokensUsed: 1_100,
            cachedInputTokens: 100,
          }),
        },
      },
    ]);

    const outcome = await runReactionLine(JOB);

    expect(outcome).toEqual({ status: "generated" });
    expect(update).toHaveBeenCalledTimes(1);
    const arg = update.mock.calls[0][0] as {
      data: { generatedAt: Date; lineEncrypted: Uint8Array };
    };
    // Ciphertext and the commit stamp land together — `load-digest` requires
    // both, so a half-written row can never surface a line.
    expect(arg.data.generatedAt).toBeInstanceOf(Date);
    expect(new TextDecoder().decode(arg.data.lineEncrypted)).toBe(
      "A solid night, deeper than your recent stretch.",
    );
    expect(reconcileSpend).toHaveBeenCalledWith(
      "u1",
      1_400,
      1_100,
      "2026-07-16",
      100,
    );
  });
});
