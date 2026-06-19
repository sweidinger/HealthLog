/**
 * v1.16.11 (#316) — the medication-reminder tick skips as-needed (PRN)
 * medications at the QUERY level: the candidate read carries
 * `asNeeded: false`, so a PRN medication never reaches the per-schedule
 * loop, never mints a missed-dose row, and never dispatches a phase
 * notification. (Structurally a PRN medication also has zero schedules,
 * so the loop would be a no-op — the predicate keeps it out of the
 * tick's per-medication intake reads entirely.)
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const prismaMock = {
  telegramScheduledDeletion: {
    findMany: vi.fn().mockResolvedValue([]),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  },
  medication: {
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    findMany: vi.fn().mockResolvedValue([]),
  },
  medicationIntakeEvent: {
    findMany: vi.fn().mockResolvedValue([]),
    findFirst: vi.fn().mockResolvedValue(null),
    create: vi.fn(),
  },
  telegramReminderMessage: {
    findUnique: vi.fn().mockResolvedValue(null),
  },
  user: {
    findFirst: vi.fn().mockResolvedValue(null),
  },
};

vi.mock("@/lib/jobs/reminder/shared", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/jobs/reminder/shared")>();
  return {
    ...actual,
    getWorkerPrisma: () => prismaMock,
    workerLog: vi.fn(),
  };
});
vi.mock("@/lib/jobs/worker-status", () => ({
  recordError: vi.fn(),
  recordReminderCheck: vi.fn(),
  markWorkerStarted: vi.fn(),
}));
vi.mock("@/lib/logging/background", () => ({
  withBackgroundEvent: vi.fn(
    async (
      _name: string,
      fn: (evt: {
        addMeta: (k: string, v: unknown) => void;
        addWarning: (m: string) => void;
        setError: (e: unknown) => void;
      }) => Promise<void>,
    ) => fn({ addMeta: vi.fn(), addWarning: vi.fn(), setError: vi.fn() }),
  ),
}));
vi.mock("@/lib/notifications/dispatcher", () => ({
  dispatchNotification: vi.fn().mockResolvedValue({ dispatched: true }),
}));
vi.mock("@/lib/crypto", () => ({ decrypt: vi.fn(() => "token") }));
vi.mock("@/lib/telegram", () => ({ deleteMessage: vi.fn() }));
vi.mock("@/lib/rollups/medication-compliance-rollups", () => ({
  recomputeMedicationComplianceForEvent: vi.fn().mockResolvedValue(undefined),
}));

import { handleReminderCheck } from "@/lib/jobs/reminder/medication-reminder-check";
import { dispatchNotification } from "@/lib/notifications/dispatcher";

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.telegramScheduledDeletion.findMany.mockResolvedValue([]);
  prismaMock.medication.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.medication.findMany.mockResolvedValue([]);
});

describe("handleReminderCheck — as-needed skip (v1.16.11, #316)", () => {
  it("queries only active NON-as-needed medications", async () => {
    await handleReminderCheck([]);

    expect(prismaMock.medication.findMany).toHaveBeenCalledTimes(1);
    const args = prismaMock.medication.findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(args.where).toEqual({ active: true, asNeeded: false });
  });

  it("dispatches nothing when the candidate set is empty", async () => {
    await handleReminderCheck([]);
    expect(dispatchNotification).not.toHaveBeenCalled();
    expect(prismaMock.medicationIntakeEvent.create).not.toHaveBeenCalled();
  });
});
