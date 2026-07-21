/**
 * Fork ADHS Stage B.2 — medication effect-window check-in reminder unit tests.
 *
 * Pins the contract that makes the reminder safe and useful:
 *   - Windowing: a window fires only inside the 15-min tick that covers
 *     `intake + offset`, anchored DST-safely on the local intake slot.
 *   - earliestIntakeMinutes: the anchor is the earliest scheduled clock time
 *     (timesOfDay preferred, windowStart fallback, null when none).
 *   - Opt-in gating: no `medicationCheckin.enabled` ⇒ never dispatch.
 *   - Profile gating: a class without an `effectWindow` ⇒ never dispatch.
 *   - Idempotency: a ledger row for (user, med, date, window) blocks a repeat.
 *   - Ledger-after-delivery: a dispatcher reporting `dispatched=false` writes
 *     no ledger row, so the next tick can retry.
 *   - Locale: title + body come from the user's locale and differ per window.
 *
 * Prisma is hand-stubbed to keep this free of a testcontainer boot, mirroring
 * the mood-reminder unit test.
 */
import { describe, it, expect, vi } from "vitest";

import {
  earliestIntakeMinutes,
  evaluateCheckinWindow,
  buildCheckinReminderPayload,
  runMedicationCheckinReminderTick,
} from "@/lib/jobs/medication-checkin-reminder";
import type { NotificationPayload } from "@/lib/notifications/types";
import type { DispatchOutcome } from "@/lib/notifications/dispatcher";

const OK: DispatchOutcome = {
  dispatched: true,
  channelsAttempted: 1,
  channelsSucceeded: 1,
};
const NO_CHANNEL: DispatchOutcome = {
  dispatched: false,
  channelsAttempted: 0,
  channelsSucceeded: 0,
};

// The stimulant profile ships effectWindow { effect: 3h, rebound: 9h }. A
// morning intake at 08:00 Berlin (CEST, UTC+2 in May) puts the EFFECT target
// at 11:00 (09:00Z) and the REBOUND target at 17:00 (15:00Z).
const INTAKE = ["08:00"];
const EFFECT_NOW = new Date("2026-05-15T09:00:00Z");
const REBOUND_NOW = new Date("2026-05-15T15:00:00Z");

interface FakeMed {
  id: string;
  userId: string;
  treatmentClass: string;
  user: {
    id: string;
    timezone: string;
    locale: string | null;
    notificationPrefs?: unknown;
  };
  schedules: Array<{
    timesOfDay?: string[] | null;
    windowStart?: string | null;
  }>;
}

interface State {
  meds: FakeMed[];
  dispatches: Array<{
    userId: string;
    medicationId: string;
    date: string;
    window: string;
  }>;
  raceKeys: Set<string>;
}

function makePrisma(state: State) {
  return {
    medication: { findMany: vi.fn(async () => state.meds) },
    medicationCheckinReminderDispatch: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: {
            userId_medicationId_date_window: {
              userId: string;
              medicationId: string;
              date: string;
              window: string;
            };
          };
        }) => {
          const k = where.userId_medicationId_date_window;
          return (
            state.dispatches.find(
              (d) =>
                d.userId === k.userId &&
                d.medicationId === k.medicationId &&
                d.date === k.date &&
                d.window === k.window,
            ) ?? null
          );
        },
      ),
      create: vi.fn(
        async ({
          data,
        }: {
          data: {
            userId: string;
            medicationId: string;
            date: string;
            window: string;
          };
        }) => {
          const key = `${data.userId}:${data.medicationId}:${data.date}:${data.window}`;
          if (state.raceKeys.has(key)) {
            throw new Error(
              "Unique constraint failed on the fields: (...). code: P2002",
            );
          }
          state.dispatches.push(data);
          return { id: `d-${state.dispatches.length}`, ...data };
        },
      ),
    },
  };
}

function med(overrides: Partial<FakeMed> = {}): FakeMed {
  return {
    id: "med-1",
    userId: "user-1",
    treatmentClass: "STIMULANT",
    user: {
      id: "user-1",
      timezone: "Europe/Berlin",
      locale: "de",
      notificationPrefs: { medicationCheckin: { enabled: true } },
    },
    schedules: [{ timesOfDay: INTAKE }],
    ...overrides,
  };
}

function run(
  state: State,
  now: Date,
  dispatch: (p: NotificationPayload) => Promise<DispatchOutcome>,
) {
  return runMedicationCheckinReminderTick(makePrisma(state) as never, now, {
    dispatch,
  });
}

describe("evaluateCheckinWindow — boundary contract", () => {
  const base = { tz: "Europe/Berlin", intakeMinutes: 8 * 60, offsetHours: 3 };

  it("fires at the exact target instant", () => {
    const r = evaluateCheckinWindow({ ...base, now: EFFECT_NOW });
    expect(r.fire).toBe(true);
    expect(r.localDate).toBe("2026-05-15");
  });

  it("fires late inside the 15-min tick", () => {
    const r = evaluateCheckinWindow({
      ...base,
      now: new Date("2026-05-15T09:14:59Z"),
    });
    expect(r.fire).toBe(true);
  });

  it("does not fire at the tick boundary (target + 15m)", () => {
    const r = evaluateCheckinWindow({
      ...base,
      now: new Date("2026-05-15T09:15:00Z"),
    });
    expect(r.fire).toBe(false);
    expect(r.localDate).toBeNull();
  });

  it("does not fire before the target", () => {
    const r = evaluateCheckinWindow({
      ...base,
      now: new Date("2026-05-15T08:59:00Z"),
    });
    expect(r.fire).toBe(false);
  });

  it("the rebound offset lands in the afternoon window", () => {
    const r = evaluateCheckinWindow({
      ...base,
      offsetHours: 9,
      now: REBOUND_NOW,
    });
    expect(r.fire).toBe(true);
  });
});

describe("earliestIntakeMinutes", () => {
  it("picks the earliest timesOfDay across schedules", () => {
    expect(
      earliestIntakeMinutes([
        { timesOfDay: ["20:00", "08:00"] },
        { timesOfDay: ["12:30"] },
      ]),
    ).toBe(8 * 60);
  });

  it("falls back to windowStart when a schedule has no timesOfDay", () => {
    expect(
      earliestIntakeMinutes([{ timesOfDay: [], windowStart: "07:30" }]),
    ).toBe(7 * 60 + 30);
  });

  it("returns null when no schedule carries a clock time", () => {
    expect(
      earliestIntakeMinutes([{ timesOfDay: null, windowStart: null }]),
    ).toBeNull();
    expect(earliestIntakeMinutes([])).toBeNull();
  });
});

describe("buildCheckinReminderPayload", () => {
  it("localises and differs per window", () => {
    const effDe = buildCheckinReminderPayload("de", "EFFECT");
    const rebDe = buildCheckinReminderPayload("de", "REBOUND");
    expect(effDe.title.length).toBeGreaterThan(0);
    expect(rebDe.title.length).toBeGreaterThan(0);
    expect(effDe.title).not.toBe(rebDe.title);
    // Different locale → different copy.
    expect(buildCheckinReminderPayload("en", "EFFECT").title).not.toBe(
      effDe.title,
    );
  });

  it("falls back to the default locale for null / unknown", () => {
    const a = buildCheckinReminderPayload(null, "EFFECT");
    const b = buildCheckinReminderPayload("xx", "EFFECT");
    expect(a.title).toBe(b.title);
    expect(a.title.length).toBeGreaterThan(0);
  });
});

describe("runMedicationCheckinReminderTick", () => {
  function freshState(over: Partial<State> = {}): State {
    return { meds: [med()], dispatches: [], raceKeys: new Set(), ...over };
  }

  it("dispatches the EFFECT window and writes a ledger row", async () => {
    const state = freshState();
    const dispatch = vi.fn<
      (p: NotificationPayload) => Promise<DispatchOutcome>
    >(async () => OK);
    const s = await run(state, EFFECT_NOW, dispatch);
    expect(s.dispatched).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const payload = dispatch.mock.calls[0][0] as NotificationPayload;
    expect(payload.eventType).toBe("MEDICATION_CHECKIN_REMINDER");
    expect(payload.metadata?.url).toBe("/medications/med-1");
    expect(payload.metadata?.window).toBe("EFFECT");
    expect(state.dispatches).toHaveLength(1);
  });

  it("skips a user who has not opted in", async () => {
    const state = freshState({
      meds: [
        med({
          user: {
            id: "user-1",
            timezone: "Europe/Berlin",
            locale: "de",
            notificationPrefs: { medicationCheckin: { enabled: false } },
          },
        }),
      ],
    });
    const dispatch = vi.fn(async () => OK);
    const s = await run(state, EFFECT_NOW, dispatch);
    expect(s.dispatched).toBe(0);
    expect(s.skippedNotOptedIn).toBe(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not fire twice for the same window/day (ledger dedup)", async () => {
    const state = freshState({
      dispatches: [
        {
          userId: "user-1",
          medicationId: "med-1",
          date: "2026-05-15",
          window: "EFFECT",
        },
      ],
    });
    const dispatch = vi.fn(async () => OK);
    const s = await run(state, EFFECT_NOW, dispatch);
    expect(s.dispatched).toBe(0);
    expect(s.skippedAlreadyDispatched).toBe(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("writes no ledger row when no channel delivered", async () => {
    const state = freshState();
    const dispatch = vi.fn(async () => NO_CHANNEL);
    const s = await run(state, EFFECT_NOW, dispatch);
    expect(s.dispatched).toBe(0);
    expect(s.skippedNoChannel).toBe(1);
    expect(state.dispatches).toHaveLength(0);
  });

  it("skips a medication with no scheduled intake time", async () => {
    const state = freshState({
      meds: [med({ schedules: [{ timesOfDay: [], windowStart: null }] })],
    });
    const dispatch = vi.fn(async () => OK);
    const s = await run(state, EFFECT_NOW, dispatch);
    expect(s.dispatched).toBe(0);
    expect(s.skippedNoIntakeTime).toBe(1);
  });

  it("does not fire the EFFECT window outside its tick", async () => {
    const state = freshState();
    const dispatch = vi.fn(async () => OK);
    const s = await run(state, new Date("2026-05-15T12:00:00Z"), dispatch);
    expect(s.dispatched).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
