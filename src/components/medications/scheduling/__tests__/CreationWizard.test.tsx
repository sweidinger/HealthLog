import { describe, expect, it } from "vitest";

import {
  buildCreateBody,
  type CreateMedicationBody,
  emptyWizardPayload,
  summariseCadence,
  validateStep,
  type WizardPayload,
} from "@/components/medications/scheduling/CreationWizard";
import { encodeCadence } from "@/components/medications/scheduling/CadencePicker";
import {
  type CadenceKind,
  DEFAULT_SUB_CONTROLS,
} from "@/components/medications/scheduling/types";

/**
 * v1.5.0 — CreationWizard pure-helper tests.
 *
 * Project convention is SSR-only Vitest (no `@testing-library/react`).
 * The wizard's interactive surface is exercised by Playwright in a
 * later commit; the three pure helpers carry the unit-test contract:
 *
 *   - `validateStep` — per-step gate boolean
 *   - `buildCreateBody` — `POST /api/medications` body encoder
 *   - `summariseCadence` — step-7 plain-language summary
 *
 * Helpers run under a stub translator so the assertions stay
 * structural (key shape, params object), not locale-specific.
 */

/**
 * Stub translator. Echoes the key + a JSON of params so the assertions
 * can pin both the chosen i18n leaf and the params passed through.
 */
function makeStubT() {
  return (key: string, params?: Record<string, string | number>): string => {
    if (!params) return key;
    return `${key}(${JSON.stringify(params)})`;
  };
}

function withCadence(
  kind: CadenceKind,
  sub: Partial<typeof DEFAULT_SUB_CONTROLS> = {},
): WizardPayload {
  const subControls = { ...DEFAULT_SUB_CONTROLS, ...sub };
  return {
    ...emptyWizardPayload(),
    mode: kind === "oneShot" ? "oneShot" : "recurring",
    name: "Foo",
    doseAmount: "5",
    doseUnit: "mg",
    cadence: encodeCadence(kind, subControls),
    subControls,
  };
}

describe("validateStep", () => {
  it("step 1: rejects empty name + empty dose; accepts both populated", () => {
    const base = emptyWizardPayload();
    expect(validateStep(base, 1)).toBe(false);
    expect(validateStep({ ...base, name: "Foo" }, 1)).toBe(false);
    expect(validateStep({ ...base, doseAmount: "5" }, 1)).toBe(false);
    expect(validateStep({ ...base, name: "Foo", doseAmount: "5" }, 1)).toBe(
      true,
    );
  });

  it("step 1: trims whitespace before deciding the gate", () => {
    const base = { ...emptyWizardPayload(), name: "   ", doseAmount: "   " };
    expect(validateStep(base, 1)).toBe(false);
  });

  it("step 2: requires a picked mode", () => {
    const base = { ...emptyWizardPayload(), name: "Foo", doseAmount: "5" };
    expect(validateStep(base, 2)).toBe(false);
    expect(validateStep({ ...base, mode: "oneShot" }, 2)).toBe(true);
    expect(validateStep({ ...base, mode: "recurring" }, 2)).toBe(true);
  });

  it("step 3: always passes for one-shot (cadence step is skipped)", () => {
    const p = withCadence("oneShot");
    expect(validateStep(p, 3)).toBe(true);
  });

  it("step 3: passes for daily / weekdays / monthly / rolling", () => {
    expect(validateStep(withCadence("daily"), 3)).toBe(true);
    expect(validateStep(withCadence("weekdays"), 3)).toBe(true);
    expect(validateStep(withCadence("monthly"), 3)).toBe(true);
    expect(validateStep(withCadence("rolling"), 3)).toBe(true);
  });

  it("step 3: rejects yearly without a real picked date", () => {
    expect(
      validateStep(withCadence("yearly", { yearlyDate: "" }), 3),
    ).toBe(false);
    expect(
      validateStep(withCadence("yearly", { yearlyDate: "2026-01-01" }), 3),
    ).toBe(true);
  });

  it("step 4: always passes (re-cap step)", () => {
    expect(validateStep(withCadence("daily"), 4)).toBe(true);
    expect(validateStep(withCadence("oneShot"), 4)).toBe(true);
  });

  it("step 5: requires at least one valid HH:mm time", () => {
    const base = withCadence("daily");
    expect(validateStep({ ...base, timesOfDay: [] }, 5)).toBe(false);
    expect(validateStep({ ...base, timesOfDay: ["nope"] }, 5)).toBe(false);
    expect(validateStep({ ...base, timesOfDay: ["08:00"] }, 5)).toBe(true);
    expect(
      validateStep({ ...base, timesOfDay: ["08:00", "20:00"] }, 5),
    ).toBe(true);
  });

  it("step 5: one-shot also requires startsOn", () => {
    const base = withCadence("oneShot");
    expect(validateStep({ ...base, startsOn: null }, 5)).toBe(false);
    expect(
      validateStep(
        { ...base, startsOn: new Date(Date.UTC(2026, 9, 15)) },
        5,
      ),
    ).toBe(true);
  });

  it("step 6: requires startsOn", () => {
    const base = withCadence("daily");
    expect(validateStep({ ...base, startsOn: null }, 6)).toBe(false);
  });

  it("step 6: accepts null endsOn (chronic)", () => {
    const base = withCadence("daily");
    expect(validateStep({ ...base, endsOn: null }, 6)).toBe(true);
  });

  it("step 6: rejects endsOn before startsOn", () => {
    const base = withCadence("daily");
    const start = new Date(Date.UTC(2026, 4, 28));
    const earlierEnd = new Date(Date.UTC(2026, 4, 1));
    expect(
      validateStep({ ...base, startsOn: start, endsOn: earlierEnd }, 6),
    ).toBe(false);
  });

  it("step 6: accepts endsOn equal to startsOn (one-shot pinned)", () => {
    const base = withCadence("oneShot");
    const start = new Date(Date.UTC(2026, 9, 15));
    expect(
      validateStep({ ...base, startsOn: start, endsOn: start }, 6),
    ).toBe(true);
  });

  it("step 7: mirrors step 6 gate", () => {
    const base = withCadence("daily");
    expect(validateStep({ ...base, startsOn: null }, 7)).toBe(false);
    const start = new Date(Date.UTC(2026, 4, 1));
    const earlier = new Date(Date.UTC(2026, 3, 1));
    expect(
      validateStep({ ...base, startsOn: start, endsOn: earlier }, 7),
    ).toBe(false);
    expect(
      validateStep({ ...base, startsOn: start, endsOn: null }, 7),
    ).toBe(true);
  });

  it("unknown step number returns false", () => {
    expect(validateStep(emptyWizardPayload(), 99)).toBe(false);
    expect(validateStep(emptyWizardPayload(), 0)).toBe(false);
  });
});

describe("buildCreateBody", () => {
  it("emits a daily recurring schedule with the rrule slot", () => {
    const p: WizardPayload = {
      ...withCadence("daily"),
      timesOfDay: ["08:00"],
      startsOn: new Date(Date.UTC(2026, 4, 28)),
      endsOn: null,
    };
    const body = buildCreateBody(p);
    expect(body.name).toBe("Foo");
    expect(body.dose).toBe("5 mg");
    expect(body.oneShot).toBe(false);
    expect(body.startsOn).toBe("2026-05-28");
    expect(body.endsOn).toBeUndefined();
    expect(body.schedules).toHaveLength(1);
    expect(body.schedules[0]).toEqual({
      windowStart: "08:00",
      windowEnd: "09:00",
      timesOfDay: ["08:00"],
      rrule: "FREQ=DAILY",
    } satisfies CreateMedicationBody["schedules"][number]);
  });

  it("derives windowEnd from the last time when several are listed", () => {
    const p: WizardPayload = {
      ...withCadence("daily"),
      timesOfDay: ["08:00", "14:00", "20:00"],
      startsOn: new Date(Date.UTC(2026, 4, 28)),
    };
    const body = buildCreateBody(p);
    expect(body.schedules[0].windowStart).toBe("08:00");
    expect(body.schedules[0].windowEnd).toBe("20:00");
    expect(body.schedules[0].timesOfDay).toEqual(["08:00", "14:00", "20:00"]);
  });

  it("sorts the times before emit (chip-row order is user-driven)", () => {
    const p: WizardPayload = {
      ...withCadence("daily"),
      timesOfDay: ["20:00", "08:00", "14:00"],
      startsOn: new Date(Date.UTC(2026, 4, 28)),
    };
    const body = buildCreateBody(p);
    expect(body.schedules[0].timesOfDay).toEqual(["08:00", "14:00", "20:00"]);
    expect(body.schedules[0].windowStart).toBe("08:00");
    expect(body.schedules[0].windowEnd).toBe("20:00");
  });

  it("emits the bi-weekly rrule on everyNWeeks (n=2, Wednesday)", () => {
    const p: WizardPayload = {
      ...withCadence("everyNWeeks", {
        intervalWeeks: 2,
        weekdays: ["WE"],
      }),
      timesOfDay: ["08:00"],
      startsOn: new Date(Date.UTC(2026, 4, 28)),
    };
    const body = buildCreateBody(p);
    expect(body.schedules[0].rrule).toBe(
      "FREQ=WEEKLY;INTERVAL=2;BYDAY=WE",
    );
    expect(body.schedules[0].rollingIntervalDays).toBeUndefined();
  });

  it("emits the quarterly rrule on everyNMonths (n=3, day=10)", () => {
    const p: WizardPayload = {
      ...withCadence("everyNMonths", {
        intervalMonths: 3,
        dayOfMonth: 10,
      }),
      timesOfDay: ["08:00"],
      startsOn: new Date(Date.UTC(2026, 4, 28)),
    };
    const body = buildCreateBody(p);
    expect(body.schedules[0].rrule).toBe(
      "FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=10",
    );
  });

  it("emits rollingIntervalDays instead of rrule when cadence is rolling", () => {
    const p: WizardPayload = {
      ...withCadence("rolling", { rollingDays: 7 }),
      timesOfDay: ["08:00"],
      startsOn: new Date(Date.UTC(2026, 4, 28)),
    };
    const body = buildCreateBody(p);
    expect(body.schedules[0].rrule).toBeUndefined();
    expect(body.schedules[0].rollingIntervalDays).toBe(7);
  });

  it("emits oneShot=true with no rrule/rolling and endsOn = startsOn", () => {
    const start = new Date(Date.UTC(2026, 9, 15));
    const p: WizardPayload = {
      ...withCadence("oneShot"),
      timesOfDay: ["09:00"],
      startsOn: start,
      endsOn: start,
    };
    const body = buildCreateBody(p);
    expect(body.oneShot).toBe(true);
    expect(body.startsOn).toBe("2026-10-15");
    expect(body.endsOn).toBe("2026-10-15");
    expect(body.schedules[0].rrule).toBeUndefined();
    expect(body.schedules[0].rollingIntervalDays).toBeUndefined();
  });

  it("emits endsOn ISO string when recurring + an end date is set", () => {
    const p: WizardPayload = {
      ...withCadence("daily"),
      timesOfDay: ["08:00"],
      startsOn: new Date(Date.UTC(2026, 4, 1)),
      endsOn: new Date(Date.UTC(2026, 11, 31)),
    };
    const body = buildCreateBody(p);
    expect(body.startsOn).toBe("2026-05-01");
    expect(body.endsOn).toBe("2026-12-31");
  });

  it("composes the dose as 'amount unit' (single-space)", () => {
    const p: WizardPayload = {
      ...withCadence("daily"),
      doseAmount: "10",
      doseUnit: "mg",
    };
    expect(buildCreateBody(p).dose).toBe("10 mg");
  });

  it("falls back to amount when unit is empty", () => {
    const p: WizardPayload = {
      ...withCadence("daily"),
      doseAmount: "10",
      doseUnit: "",
    };
    expect(buildCreateBody(p).dose).toBe("10");
  });

  it("trims the name before emit", () => {
    const p: WizardPayload = {
      ...withCadence("daily"),
      name: "  Foo  ",
    };
    expect(buildCreateBody(p).name).toBe("Foo");
  });

  it("falls back to a default window when the user passes only invalid times", () => {
    const p: WizardPayload = {
      ...withCadence("daily"),
      timesOfDay: ["not-a-time"],
    };
    const body = buildCreateBody(p);
    expect(body.schedules[0].timesOfDay).toEqual([]);
    expect(body.schedules[0].windowStart).toBe("08:00");
    expect(body.schedules[0].windowEnd).toBe("09:00");
  });

  it("handles the 23:30 + 1h wraparound cleanly (single-time case)", () => {
    const p: WizardPayload = {
      ...withCadence("daily"),
      timesOfDay: ["23:30"],
    };
    const body = buildCreateBody(p);
    expect(body.schedules[0].windowStart).toBe("23:30");
    expect(body.schedules[0].windowEnd).toBe("00:30");
  });
});

describe("summariseCadence", () => {
  const t = makeStubT();

  it("uses the 'daily' summary key for daily cadence", () => {
    const out = summariseCadence(withCadence("daily"), t);
    expect(out).toContain("medications.create.wizard.step7.summary.cadence.daily");
  });

  it("uses 'weekdays' for the weekday-subset cadence", () => {
    const out = summariseCadence(
      withCadence("weekdays", { weekdays: ["MO", "WE", "FR"] }),
      t,
    );
    expect(out).toContain(
      "medications.create.wizard.step7.summary.cadence.weekdays",
    );
  });

  it("uses 'biweekly' for everyNWeeks with n=2", () => {
    const out = summariseCadence(
      withCadence("everyNWeeks", { intervalWeeks: 2 }),
      t,
    );
    expect(out).toContain(
      "medications.create.wizard.step7.summary.cadence.biweekly",
    );
  });

  it("uses 'everyNWeeks' for n != 2", () => {
    const out = summariseCadence(
      withCadence("everyNWeeks", { intervalWeeks: 4 }),
      t,
    );
    expect(out).toContain(
      "medications.create.wizard.step7.summary.cadence.everyNWeeks",
    );
  });

  it("uses 'quarterly' for everyNMonths with n=3", () => {
    const out = summariseCadence(
      withCadence("everyNMonths", { intervalMonths: 3 }),
      t,
    );
    expect(out).toContain(
      "medications.create.wizard.step7.summary.cadence.quarterly",
    );
  });

  it("uses 'monthly' for the monthly cadence (BYMONTHDAY only)", () => {
    const out = summariseCadence(withCadence("monthly", { dayOfMonth: 1 }), t);
    expect(out).toContain(
      "medications.create.wizard.step7.summary.cadence.monthly",
    );
  });

  it("uses 'yearly' for the yearly cadence", () => {
    const out = summariseCadence(
      withCadence("yearly", { yearlyDate: "2026-01-01" }),
      t,
    );
    expect(out).toContain(
      "medications.create.wizard.step7.summary.cadence.yearly",
    );
  });

  it("uses 'rolling' for rolling-interval cadence", () => {
    const out = summariseCadence(
      withCadence("rolling", { rollingDays: 7 }),
      t,
    );
    expect(out).toContain(
      "medications.create.wizard.step7.summary.cadence.rolling",
    );
  });

  it("uses 'oneShot' for one-shot cadence + omits the endsOn phrase", () => {
    const start = new Date(Date.UTC(2026, 9, 15));
    const p: WizardPayload = {
      ...withCadence("oneShot"),
      startsOn: start,
      endsOn: start,
    };
    const out = summariseCadence(p, t);
    expect(out).toContain(
      "medications.create.wizard.step7.summary.cadence.oneShot",
    );
    expect(out).not.toContain("step7.summary.endsOn");
    expect(out).not.toContain("step7.summary.noEndDate");
  });

  it("surfaces 'noEndDate' when recurring + endsOn null", () => {
    const p: WizardPayload = {
      ...withCadence("daily"),
      startsOn: new Date(Date.UTC(2026, 4, 28)),
      endsOn: null,
    };
    const out = summariseCadence(p, t);
    expect(out).toContain(
      "medications.create.wizard.step7.summary.noEndDate",
    );
  });

  it("surfaces the formatted endsOn when recurring + endsOn set", () => {
    const p: WizardPayload = {
      ...withCadence("daily"),
      startsOn: new Date(Date.UTC(2026, 4, 1)),
      endsOn: new Date(Date.UTC(2026, 11, 31)),
    };
    const out = summariseCadence(p, t);
    expect(out).toMatch(/step7\.summary\.endsOn[^|]*"2026-12-31"/);
  });

  it("forwards the rolling interval as the n param", () => {
    const p: WizardPayload = {
      ...withCadence("rolling", { rollingDays: 14 }),
    };
    const out = summariseCadence(p, t);
    // stub-t renders `(key)({"n":14})` so the assertion confirms the
    // n param threads from sub-controls → summary key params.
    expect(out).toMatch(/cadence\.rolling[^|]*"n":14/);
  });

  it("forwards the times list to the 'times' key", () => {
    const p: WizardPayload = {
      ...withCadence("daily"),
      timesOfDay: ["08:00", "20:00"],
    };
    const out = summariseCadence(p, t);
    expect(out).toMatch(/step7\.summary\.times[^|]*"08:00, 20:00"/);
  });
});
