/**
 * v1.15.18 — traceable dose-history reconstruction (spec B).
 *
 * Produces a complete, attributable ledger from the expected-slot bands +
 * the actual intake rows:
 *   - every expected slot appears with a status (taken_on_time / taken_late /
 *     skipped / missed / upcoming) even when never taken;
 *   - a TAKEN intake is attributed to a slot by its real `takenAt` band
 *     membership (NOT the stored, possibly-snapped `scheduledFor`), so the
 *     corrected bands converge forward over legacy mis-snapped rows;
 *   - skipped / auto-missed / pending rows bind to their slot by anchor
 *     (they were written against a slot deliberately);
 *   - a taken intake matching no slot band is emitted as a tagged `ad_hoc`
 *     row at its real time — never silently snapped onto a scheduled slot.
 */
import { describe, expect, it } from "vitest";

import { buildSlotBands, type SlotWindowInput } from "../attribution";
import {
  reconstructDoseHistory,
  type HistoryIntake,
} from "../dose-history";
import { localHmAsUtc } from "@/lib/timezone";

const TZ = "Europe/Berlin";
const MIN = 60_000;
const day = new Date("2026-06-08T12:00:00Z");

function pointSlot(at: Date, timeOfDay: string): SlotWindowInput {
  return {
    at,
    timeOfDay,
    onTimeStart: new Date(at.getTime() - 60 * MIN),
    onTimeEnd: new Date(at.getTime() + 60 * MIN),
    lateGraceMs: 180 * MIN,
  };
}
const bands = buildSlotBands([
  pointSlot(localHmAsUtc(day, TZ, 7, 0), "07:00"),
  pointSlot(localHmAsUtc(day, TZ, 19, 0), "19:00"),
]);

function at(h: number, m: number): Date {
  return localHmAsUtc(day, TZ, h, m);
}
function intake(over: Partial<HistoryIntake>): HistoryIntake {
  return {
    id: "i",
    scheduledFor: at(7, 0),
    takenAt: null,
    skipped: false,
    autoMissed: false,
    ...over,
  };
}

// Late "now" so both of today's slots are past their miss cutoff.
const nowEvening = at(23, 59);

describe("reconstructDoseHistory", () => {
  it("emits one row per expected slot even with no intakes", () => {
    const rows = reconstructDoseHistory(bands, [], nowEvening);
    expect(rows.map((r) => r.timeOfDay)).toEqual(["07:00", "19:00"]);
    expect(rows.every((r) => r.kind === "slot")).toBe(true);
    expect(rows.map((r) => r.status)).toEqual(["missed", "missed"]);
  });

  it("attributes an on-time take to its slot", () => {
    const rows = reconstructDoseHistory(
      bands,
      [intake({ takenAt: at(7, 0), scheduledFor: at(7, 0) })],
      nowEvening,
    );
    const morning = rows.find((r) => r.timeOfDay === "07:00");
    expect(morning?.status).toBe("taken_on_time");
    expect(morning?.intake?.takenAt?.toISOString()).toBe(at(7, 0).toISOString());
  });

  it("attributes a take inside the late tail as taken_late", () => {
    const rows = reconstructDoseHistory(
      bands,
      [intake({ takenAt: at(8, 30), scheduledFor: at(7, 0) })],
      nowEvening,
    );
    expect(rows.find((r) => r.timeOfDay === "07:00")?.status).toBe("taken_late");
  });

  it("emits an 11:29 take as an ad-hoc row and leaves 07:00 missed", () => {
    // Marc's case: the stored scheduledFor was snapped to 07:00 by the old
    // write path, but the real takenAt (11:29) is outside every band → ad-hoc.
    const rows = reconstructDoseHistory(
      bands,
      [intake({ takenAt: at(11, 29), scheduledFor: at(7, 0) })],
      nowEvening,
    );
    const adhoc = rows.find((r) => r.kind === "ad_hoc");
    expect(adhoc?.status).toBe("ad_hoc");
    expect(adhoc?.at.toISOString()).toBe(at(11, 29).toISOString());
    expect(rows.find((r) => r.timeOfDay === "07:00")?.status).toBe("missed");
  });

  it("binds an explicit skip to its slot by anchor", () => {
    const rows = reconstructDoseHistory(
      bands,
      [intake({ skipped: true, scheduledFor: at(7, 0) })],
      nowEvening,
    );
    expect(rows.find((r) => r.timeOfDay === "07:00")?.status).toBe("skipped");
  });

  it("counts an auto-missed pending row as missed", () => {
    const rows = reconstructDoseHistory(
      bands,
      [intake({ autoMissed: true, scheduledFor: at(7, 0) })],
      nowEvening,
    );
    expect(rows.find((r) => r.timeOfDay === "07:00")?.status).toBe("missed");
  });

  it("marks a future slot upcoming, not missed", () => {
    const earlyMorning = at(5, 0); // before every slot's miss cutoff
    const rows = reconstructDoseHistory(bands, [], earlyMorning);
    expect(rows.find((r) => r.timeOfDay === "07:00")?.status).toBe("upcoming");
    expect(rows.find((r) => r.timeOfDay === "19:00")?.status).toBe("upcoming");
  });

  it("a second take near an already-filled slot becomes ad-hoc", () => {
    const rows = reconstructDoseHistory(
      bands,
      [
        intake({ id: "a", takenAt: at(7, 0), scheduledFor: at(7, 0) }),
        intake({ id: "b", takenAt: at(7, 20), scheduledFor: at(7, 0) }),
      ],
      nowEvening,
    );
    expect(rows.find((r) => r.timeOfDay === "07:00")?.status).toBe(
      "taken_on_time",
    );
    const adhoc = rows.filter((r) => r.kind === "ad_hoc");
    expect(adhoc).toHaveLength(1);
    expect(adhoc[0].intake?.id).toBe("b");
  });

  // v1.15.19 — time-aware pending-row semantics. The today-projector and the
  // reminder worker mint pending rows (takenAt = null, neither skipped nor
  // auto-missed) for every slot of the day up front, so a pending row's
  // status must be derived from the clock exactly like an unfilled slot's:
  // missed only past the slot's miss cutoff, upcoming until then.
  describe("pending (server-minted) rows", () => {
    it("reads upcoming while now is inside the slot's overdue window", () => {
      // 07:00 slot: on-time ends 08:00, late tail ends 11:00. At 08:30 the
      // dose is still takeable — the pending row must not read missed.
      const rows = reconstructDoseHistory(
        bands,
        [intake({ scheduledFor: at(7, 0) })],
        at(8, 30),
      );
      const morning = rows.find((r) => r.timeOfDay === "07:00");
      expect(morning?.status).toBe("upcoming");
      // The row stays bound to its slot (the intake annotates it).
      expect(morning?.intake?.id).toBe("i");
    });

    it("reads missed once now is past the slot's overdueEnd", () => {
      // 07:00 band's miss cutoff is 11:00; at 12:00 the dose is gone.
      const rows = reconstructDoseHistory(
        bands,
        [intake({ scheduledFor: at(7, 0) })],
        at(12, 0),
      );
      expect(rows.find((r) => r.timeOfDay === "07:00")?.status).toBe("missed");
    });

    it("weekly slot: a pending row 2 days past the anchor stays upcoming inside the 4-day tail", () => {
      const HOUR_MS = 60 * MIN;
      const DAY_MS = 24 * HOUR_MS;
      const weeklyAt = localHmAsUtc(day, TZ, 7, 0);
      const weeklyBands = buildSlotBands([
        {
          at: weeklyAt,
          timeOfDay: "07:00",
          onTimeStart: new Date(weeklyAt.getTime() - 12 * HOUR_MS),
          onTimeEnd: new Date(weeklyAt.getTime() + 12 * HOUR_MS),
          // Weekly injectable: the clinical 4-day late tail.
          lateGraceMs: 4 * DAY_MS,
        },
      ]);
      const twoDaysLater = new Date(weeklyAt.getTime() + 2 * DAY_MS);
      const rows = reconstructDoseHistory(
        weeklyBands,
        [intake({ scheduledFor: weeklyAt })],
        twoDaysLater,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("upcoming");
    });

    it("drops a pending row matching no band instead of emitting a phantom ad-hoc row", () => {
      // `to = now` early-afternoon read: the 19:00 band is outside the
      // minted window, but the projector already minted the evening pending
      // row. It is a server placeholder, not a user action — it must not
      // surface as an ad-hoc row with takenAt = null.
      const morningOnly = bands.filter((b) => b.timeOfDay === "07:00");
      const rows = reconstructDoseHistory(
        morningOnly,
        [intake({ scheduledFor: at(19, 0) })],
        at(14, 0),
      );
      expect(rows.filter((r) => r.kind === "ad_hoc")).toHaveLength(0);
      expect(rows.map((r) => r.timeOfDay)).toEqual(["07:00"]);
    });

    it("a skip with no band match still surfaces ad-hoc (deliberate action)", () => {
      const morningOnly = bands.filter((b) => b.timeOfDay === "07:00");
      const rows = reconstructDoseHistory(
        morningOnly,
        [intake({ skipped: true, scheduledFor: at(19, 0) })],
        at(14, 0),
      );
      expect(rows.filter((r) => r.kind === "ad_hoc")).toHaveLength(1);
    });

    it("auto-missed stays missed even while the overdue window is still open", () => {
      // The cron's verdict is authoritative — the clock does not resurrect it.
      const rows = reconstructDoseHistory(
        bands,
        [intake({ autoMissed: true, scheduledFor: at(7, 0) })],
        at(8, 30),
      );
      expect(rows.find((r) => r.timeOfDay === "07:00")?.status).toBe("missed");
    });
  });

  it("returns rows in chronological order (slots + ad-hoc interleaved)", () => {
    const rows = reconstructDoseHistory(
      bands,
      [intake({ id: "x", takenAt: at(13, 0), scheduledFor: at(13, 0) })],
      nowEvening,
    );
    const times = rows.map((r) => r.at.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});
