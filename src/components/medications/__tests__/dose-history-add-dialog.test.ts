import { describe, expect, it } from "vitest";

import {
  classifyTake,
  nearestSlotForTake,
} from "@/components/medications/dose-history-add-dialog";

/**
 * v1.15.18 WE — the late-take nudge classifier behind the Verlauf add dialog.
 * A take inside the ±1h on-time window pins to its slot directly; a near-miss
 * (≤4h gap) prompts "diesem Slot zuordnen?"; anything further is ad-hoc; a PRN
 * med (no times) is always ad-hoc.
 */

describe("nearestSlotForTake", () => {
  it("finds the closest slot on the take's own day with the gap in minutes", () => {
    const near = nearestSlotForTake("2026-06-01T08:30", ["07:00", "19:00"]);
    expect(near?.slotHm).toBe("07:00");
    expect(near?.gapMinutes).toBe(90);
  });

  it("returns null for a PRN medication with no time-anchored slots", () => {
    expect(nearestSlotForTake("2026-06-01T08:30", [])).toBeNull();
  });
});

describe("classifyTake", () => {
  it("treats an in-window take (≤60 min) as an exact slot match", () => {
    expect(
      classifyTake(nearestSlotForTake("2026-06-01T07:30", ["07:00"])),
    ).toBe("exact");
  });

  it("prompts the nudge for a near-miss take (61–240 min off the slot)", () => {
    expect(
      classifyTake(nearestSlotForTake("2026-06-01T09:00", ["07:00"])),
    ).toBe("nudge");
  });

  it("records ad-hoc when the take is far from every slot", () => {
    expect(
      classifyTake(nearestSlotForTake("2026-06-01T14:00", ["07:00"])),
    ).toBe("ad_hoc");
  });

  it("records ad-hoc for a PRN medication (no slots)", () => {
    expect(classifyTake(null)).toBe("ad_hoc");
  });
});
