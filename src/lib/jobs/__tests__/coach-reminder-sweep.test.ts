/**
 * v1.22 (M4) — daily Coach-reminder sweep.
 *
 * Covers: overdue active date-reminders flip to `due`; a passed CoachPlan
 * reviewDate mints a one-off reminder from the plan's own cue→action text and
 * clears the reviewDate (activating the dangling B1 column); an undecryptable
 * plan is skipped (counted errored) without sinking the tick.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/ai/coach/bytes-codec", () => ({
  decryptFromBytes: (buf: Uint8Array) => {
    const tag = Buffer.from(buf).toString("utf8");
    if (tag === "__bad__") throw new Error("unknown key id");
    return `dec:${tag}`;
  },
  encryptToBytes: (s: string) => new Uint8Array(Buffer.from(`enc:${s}`)),
}));

import { runCoachReminderSweep } from "../coach-reminder-sweep";

const NOW = new Date("2026-06-27T05:20:00.000Z");

function bytes(tag: string): Uint8Array {
  return new Uint8Array(Buffer.from(tag, "utf8"));
}

describe("runCoachReminderSweep", () => {
  it("flips overdue active date-reminders to due and mints plan-review reminders", async () => {
    const prisma = {
      coachReminder: {
        updateMany: vi.fn(async () => ({ count: 3 })),
        create: vi.fn(async () => ({ id: "r-new" })),
      },
      coachPlan: {
        findMany: vi.fn(async () => [
          {
            id: "p1",
            userId: "u1",
            metric: "WEIGHT",
            ifCueEncrypted: bytes("every morning"),
            thenActionEncrypted: bytes("weigh in"),
          },
        ]),
        update: vi.fn(async () => ({})),
      },
      // The mint runs as one atomic batch; resolve the built ops together.
      $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    };

    const summary = await runCoachReminderSweep(prisma as never, NOW);
    expect(summary.remindersDue).toBe(3);
    expect(summary.planReviewsMinted).toBe(1);
    expect(summary.errored).toBe(0);

    // The flip query is scoped to active, date-triggered, overdue rows.
    const flipArgs = prisma.coachReminder.updateMany.mock
      .calls[0] as unknown as [
      { where: { status: string; triggerKind: string; dueAt: unknown } },
    ];
    const where = flipArgs[0].where;
    expect(where.status).toBe("active");
    expect(where.triggerKind).toBe("date");
    expect(where.dueAt).toEqual({ not: null, lte: NOW });

    // The minted reminder carries the plan's own prose + relatedPlanId.
    const createArgs = prisma.coachReminder.create.mock.calls[0] as unknown as [
      { data: { relatedPlanId: string; source: string; status: string } },
    ];
    const data = createArgs[0].data;
    expect(data.relatedPlanId).toBe("p1");
    expect(data.source).toBe("extractor");
    expect(data.status).toBe("due");

    // The plan's reviewDate is cleared so the review fires exactly once.
    expect(prisma.coachPlan.update).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: { reviewDate: null },
    });

    // The create + clear commit atomically — a half-applied mint would let the
    // next tick re-select the plan and duplicate the review reminder.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("skips an undecryptable plan without sinking the tick", async () => {
    const prisma = {
      coachReminder: {
        updateMany: vi.fn(async () => ({ count: 0 })),
        create: vi.fn(async () => ({ id: "r-new" })),
      },
      coachPlan: {
        findMany: vi.fn(async () => [
          {
            id: "p1",
            userId: "u1",
            metric: "SLEEP",
            ifCueEncrypted: bytes("__bad__"),
            thenActionEncrypted: bytes("lights out"),
          },
        ]),
        update: vi.fn(async () => ({})),
      },
      $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    };

    const summary = await runCoachReminderSweep(prisma as never, NOW);
    expect(summary.planReviewsMinted).toBe(0);
    expect(summary.errored).toBe(1);
    expect(prisma.coachReminder.create).not.toHaveBeenCalled();
    expect(prisma.coachPlan.update).not.toHaveBeenCalled();
  });
});
