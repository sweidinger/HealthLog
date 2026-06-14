import { describe, it, expect } from "vitest";

import {
  buildDayLogPatch,
  buildDayLogInput,
  symptomsCount,
  temperatureCount,
  intimacyCount,
  testsCount,
  noteCount,
  type DayLogFormState,
} from "../log-day-sheet";

function blank(): DayLogFormState {
  return {
    flow: null,
    intermenstrual: false,
    bbt: "",
    bbtDisturbed: false,
    opk: null,
    mucus: null,
    cervixPosition: null,
    cervixFirmness: null,
    cervixOpening: null,
    intercourse: false,
    protectedSex: false,
    pregnancyTest: null,
    progesteroneTest: null,
    contraceptive: null,
    note: "",
    symptoms: new Map(),
  };
}

describe("buildDayLogPatch (edit → clear semantics, QA W-2)", () => {
  it("sends explicit null for every deselected enum so an edit clears it", () => {
    const patch = buildDayLogPatch(blank());
    // A blank form on an EXISTING row must null every field, not omit it —
    // omission would leave the stored value behind (the bug this fixes).
    expect(patch.flow).toBeNull();
    expect(patch.ovulationTest).toBeNull();
    expect(patch.cervicalMucus).toBeNull();
    expect(patch.pregnancyTest).toBeNull();
    expect(patch.progesteroneTest).toBeNull();
    expect(patch.contraceptive).toBeNull();
    expect(patch.basalBodyTempC).toBeNull();
    expect(patch.note).toBeNull();
    // Keys are PRESENT (not omitted) so the server actually applies the clear.
    expect("flow" in patch).toBe(true);
    expect("cervicalMucus" in patch).toBe(true);
  });

  it("carries the set values through and gates protection on intercourse", () => {
    const patch = buildDayLogPatch({
      ...blank(),
      flow: "MEDIUM",
      opk: "POSITIVE_LH_SURGE",
      bbt: "36.62",
      intercourse: true,
      protectedSex: true,
      note: "  hello  ",
      symptoms: new Map([["cramps", 3]]),
    });
    expect(patch.flow).toBe("MEDIUM");
    expect(patch.ovulationTest).toBe("POSITIVE_LH_SURGE");
    expect(patch.basalBodyTempC).toBe(36.62);
    expect(patch.protectedSex).toBe(true);
    expect(patch.note).toBe("hello");
    expect(patch.symptoms).toEqual([{ key: "cramps", severity: 3 }]);
  });

  it("nulls protection when no intercourse is logged", () => {
    const patch = buildDayLogPatch({
      ...blank(),
      intercourse: false,
      protectedSex: true,
    });
    expect(patch.sexualActivity).toBe(false);
    expect(patch.protectedSex).toBeNull();
  });
});

describe("buildDayLogInput (new row → omit empties)", () => {
  it("omits unset enums but posts an explicit empty note", () => {
    const input = buildDayLogInput(blank(), "2026-06-06");
    expect("flow" in input).toBe(false);
    expect("ovulationTest" in input).toBe(false);
    expect("basalBodyTempC" in input).toBe(false);
    expect(input.note).toBe("");
    expect(input.date).toBe("2026-06-06");
    expect(input.source).toBe("MANUAL");
  });

  it("includes set values for a new row", () => {
    const input = buildDayLogInput(
      { ...blank(), flow: "LIGHT", bbt: "36.5" },
      "2026-06-06",
    );
    expect(input.flow).toBe("LIGHT");
    expect(input.basalBodyTempC).toBe(36.5);
  });

  it("carries the disturbed flag alongside a BBT reading", () => {
    const input = buildDayLogInput(
      { ...blank(), bbt: "36.5", bbtDisturbed: true },
      "2026-06-06",
    );
    expect(input.basalBodyTempC).toBe(36.5);
    expect(input.temperatureExcluded).toBe(true);
    const patch = buildDayLogPatch({ ...blank(), bbt: "36.5", bbtDisturbed: true });
    expect(patch.temperatureExcluded).toBe(true);
  });

  it("carries the cervix signs through both payload builders", () => {
    const state = {
      ...blank(),
      cervixPosition: "HIGH" as const,
      cervixFirmness: "SOFT" as const,
      cervixOpening: "OPEN" as const,
    };
    const input = buildDayLogInput(state, "2026-06-06");
    expect(input.cervixPosition).toBe("HIGH");
    expect(input.cervixFirmness).toBe("SOFT");
    expect(input.cervixOpening).toBe("OPEN");
    // A blank edit nulls every cervix sign (clear semantics).
    const patch = buildDayLogPatch(blank());
    expect(patch.cervixPosition).toBeNull();
    expect(patch.cervixFirmness).toBeNull();
    expect(patch.cervixOpening).toBeNull();
  });

  it("never marks an absent BBT reading disturbed", () => {
    // A disturbed flag with no temperature is meaningless — it must reset.
    const patch = buildDayLogPatch({ ...blank(), bbt: "", bbtDisturbed: true });
    expect(patch.basalBodyTempC).toBeNull();
    expect(patch.temperatureExcluded).toBe(false);
    const input = buildDayLogInput(
      { ...blank(), bbt: "", bbtDisturbed: true },
      "2026-06-06",
    );
    expect("temperatureExcluded" in input).toBe(false);
  });
});

describe("section summary-badge counts (v1.17.0)", () => {
  it("counts each logged symptom", () => {
    expect(symptomsCount(blank())).toBe(0);
    const s = { ...blank(), symptoms: new Map([["cramps", 2], ["headache", null]]) };
    expect(symptomsCount(s)).toBe(2);
  });

  it("counts only the rendered symptothermal sign alongside BBT and OPK", () => {
    expect(temperatureCount(blank(), false)).toBe(0);
    // A non-finite / empty BBT string does not count.
    expect(temperatureCount({ ...blank(), bbt: "abc" }, false)).toBe(0);
    const s: DayLogFormState = {
      ...blank(),
      bbt: "36.5",
      opk: "POSITIVE_LH_SURGE",
      mucus: "EGG_WHITE",
      cervixPosition: "HIGH",
      cervixFirmness: "SOFT",
      cervixOpening: "OPEN",
    };
    // Mucus surface (showCervix=false): BBT + OPK + mucus = 3; cervix signs
    // are not rendered, so they don't count.
    expect(temperatureCount(s, false)).toBe(3);
    // Cervix surface (showCervix=true): BBT + OPK + 3 cervix signs = 5; the
    // stale mucus value is not rendered, so it doesn't count.
    expect(temperatureCount(s, true)).toBe(5);
  });

  it("counts intercourse and contraceptive", () => {
    expect(intimacyCount(blank())).toBe(0);
    expect(
      intimacyCount({ ...blank(), intercourse: true, contraceptive: "ORAL" }),
    ).toBe(2);
  });

  it("counts each home-test result", () => {
    expect(testsCount(blank())).toBe(0);
    expect(
      testsCount({
        ...blank(),
        pregnancyTest: "NEGATIVE",
        progesteroneTest: "POSITIVE",
      }),
    ).toBe(2);
  });

  it("counts a note only when it carries non-whitespace content", () => {
    expect(noteCount(blank())).toBe(0);
    expect(noteCount({ ...blank(), note: "   " })).toBe(0);
    expect(noteCount({ ...blank(), note: "tired today" })).toBe(1);
  });
});
