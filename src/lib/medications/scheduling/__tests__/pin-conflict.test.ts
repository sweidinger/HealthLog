/**
 * v1.16.0 — `findPinConflict`, the guard behind the 422
 * `medications.intake.force_slot.occupied` refusal on the USER_PIN write
 * paths. A pin moves a DIFFERENT take onto a named slot; converging it
 * onto a slot whose live row is already actioned would overwrite that
 * recorded action through the explicit-write last-write-wins rule — a
 * silent loss of a dose record. The ledger UI only offers the pin for
 * unserved slots, so the guard is the API-level backstop.
 */
import { describe, expect, it, vi } from "vitest";

import { findPinConflict } from "../slot-upsert";

const SLOT = new Date("2026-06-15T05:00:00.000Z");

interface StubRow {
  id: string;
  takenAt: Date | null;
  skipped: boolean;
  idempotencyKey: string | null;
  scheduledFor: Date;
  source: string;
  createdAt: Date;
}

function clientWithRows(rows: StubRow[]) {
  return {
    medication: {} as never,
    medicationIntakeEvent: {
      findMany: vi.fn().mockResolvedValue(rows),
    } as never,
  };
}

function row(overrides: Partial<StubRow>): StubRow {
  return {
    id: "r-1",
    takenAt: null,
    skipped: false,
    idempotencyKey: null,
    scheduledFor: SLOT,
    source: "WEB",
    createdAt: new Date("2026-06-15T00:00:00Z"),
    ...overrides,
  };
}

describe("findPinConflict", () => {
  it("does not conflict with an empty slot or a pending projection row", async () => {
    expect(
      await findPinConflict({
        userId: "u1",
        medicationId: "m1",
        canonicalSlot: SLOT,
        incomingTakenAt: new Date("2026-06-15T09:30:00Z"),
        client: clientWithRows([]),
      }),
    ).toBe(false);

    expect(
      await findPinConflict({
        userId: "u1",
        medicationId: "m1",
        canonicalSlot: SLOT,
        incomingTakenAt: new Date("2026-06-15T09:30:00Z"),
        client: clientWithRows([row({ takenAt: null, skipped: false })]),
      }),
    ).toBe(false);
  });

  it("conflicts with a live taken row carrying a different takenAt", async () => {
    expect(
      await findPinConflict({
        userId: "u1",
        medicationId: "m1",
        canonicalSlot: SLOT,
        incomingTakenAt: new Date("2026-06-15T09:30:00Z"),
        client: clientWithRows([
          row({ takenAt: new Date("2026-06-15T05:05:00Z") }),
        ]),
      }),
    ).toBe(true);
  });

  it("conflicts with an explicitly skipped slot row", async () => {
    expect(
      await findPinConflict({
        userId: "u1",
        medicationId: "m1",
        canonicalSlot: SLOT,
        incomingTakenAt: new Date("2026-06-15T09:30:00Z"),
        client: clientWithRows([row({ skipped: true })]),
      }),
    ).toBe(true);
  });

  it("treats an identical takenAt as an idempotent re-post, not a conflict", async () => {
    const takenAt = new Date("2026-06-15T09:30:00Z");
    expect(
      await findPinConflict({
        userId: "u1",
        medicationId: "m1",
        canonicalSlot: SLOT,
        incomingTakenAt: takenAt,
        client: clientWithRows([row({ takenAt: new Date(takenAt) })]),
      }),
    ).toBe(false);
  });

  it("never conflicts with the row being edited itself (excludeEventId)", async () => {
    expect(
      await findPinConflict({
        userId: "u1",
        medicationId: "m1",
        canonicalSlot: SLOT,
        incomingTakenAt: new Date("2026-06-15T09:30:00Z"),
        excludeEventId: "r-1",
        client: clientWithRows([
          row({ id: "r-1", takenAt: new Date("2026-06-15T05:05:00Z") }),
        ]),
      }),
    ).toBe(false);
  });
});
