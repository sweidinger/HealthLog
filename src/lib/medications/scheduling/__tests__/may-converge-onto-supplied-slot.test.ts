/**
 * Dose-safety guard for the intake routes' ad-hoc convergence probe.
 *
 * Regression for the "late-morning take consumes the evening slot" bug: the
 * medication card advances its display-due to the 21:00 slot once the 09:00
 * slot's catch-up window has lapsed, so a "Genommen" tap at 13:08 posts
 * `scheduledFor = 21:00` with `takenAt = now`. Band attribution correctly
 * refuses the take (it falls in no window), but the source-agnostic
 * convergence probe used to bind it to the 21:00 pending REMINDER row —
 * recording a morning dose as the evening one and silently consuming a slot
 * the user had not reached. The guard keeps a taken write off any slot whose
 * anchor is in the future relative to the take.
 */
import { describe, expect, it } from "vitest";

import { mayConvergeOntoSuppliedSlot } from "@/lib/medications/scheduling/slot-upsert";

const DAY = "2026-03-10";
const at = (hm: string) => new Date(`${DAY}T${hm}:00.000Z`);

describe("mayConvergeOntoSuppliedSlot", () => {
  it("refuses a taken write onto a slot in the future (the 13:08 → 21:00 bug)", () => {
    expect(
      mayConvergeOntoSuppliedSlot({
        skipped: false,
        takenAt: at("13:08"),
        suppliedSlot: at("21:00"),
      }),
    ).toBe(false);
  });

  it("allows a taken write onto a PAST slot (ledger 'mark the missed 09:00 slot taken')", () => {
    expect(
      mayConvergeOntoSuppliedSlot({
        skipped: false,
        takenAt: at("13:08"),
        suppliedSlot: at("09:00"),
      }),
    ).toBe(true);
  });

  it("allows a taken write onto the current slot within the forward clock-skew grace", () => {
    expect(
      mayConvergeOntoSuppliedSlot({
        skipped: false,
        takenAt: at("08:58"),
        suppliedSlot: at("09:00"),
      }),
    ).toBe(true);
  });

  it("refuses a taken write onto a slot just beyond the forward grace", () => {
    expect(
      mayConvergeOntoSuppliedSlot({
        skipped: false,
        takenAt: at("08:50"),
        suppliedSlot: at("09:00"),
      }),
    ).toBe(false);
  });

  it("always allows a deliberate skip to name its slot (past or future)", () => {
    expect(
      mayConvergeOntoSuppliedSlot({
        skipped: true,
        takenAt: null,
        suppliedSlot: at("21:00"),
      }),
    ).toBe(true);
  });

  it("always allows a pending echo (no takenAt) to target a future slot", () => {
    expect(
      mayConvergeOntoSuppliedSlot({
        skipped: false,
        takenAt: null,
        suppliedSlot: at("21:00"),
      }),
    ).toBe(true);
  });
});
