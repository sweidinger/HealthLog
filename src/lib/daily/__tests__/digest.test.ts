import { describe, it, expect } from "vitest";

import { getServerTranslator } from "@/lib/i18n/server-translator";
import type { DailyBriefing } from "@/lib/ai/schema";
import type { MedsTodayBlock } from "@/lib/dashboard/meds-today";
import {
  buildDailyDigest,
  MAX_WORTH_A_LOOK,
  type DailyDigestInput,
} from "@/lib/daily/digest";

const t = getServerTranslator("en").t;
const NOW = new Date("2026-07-16T09:00:00.000Z");

function meds(over: Partial<MedsTodayBlock> = {}): MedsTodayBlock {
  return {
    activeCount: 0,
    scheduledToday: 0,
    takenToday: 0,
    skippedToday: 0,
    nextDueAt: null,
    nextDueOverdue: false,
    nextDueMedicationName: null,
    ...over,
  };
}

const briefing: DailyBriefing = {
  paragraph:
    "Your blood pressure is holding steady this week. Sleep dipped slightly last night.",
  signalsOfDay: [
    {
      sourceMetric: "bp",
      tone: "good",
      headline: "Blood pressure is holding steady",
      nudge: "Keep the evening walks going.",
      delta: null,
    },
  ],
  keyFindings: [],
};

function input(over: Partial<DailyDigestInput> = {}): DailyDigestInput {
  return {
    now: NOW,
    modules: {},
    score: { value: 82, band: "good", delta: 3 },
    briefing,
    medsToday: meds(),
    sleepLastSeenDaysAgo: 0,
    syncIssues: [],
    preventiveDue: [],
    ...over,
  };
}

describe("buildDailyDigest — composition", () => {
  it("lifts score, top signal, and briefing lead from cached inputs (no recompute)", () => {
    const d = buildDailyDigest(input(), t);
    expect(d.generatedAt).toBe(NOW.toISOString());
    expect(d.score).toEqual({ value: 82, band: "good", delta: 3 });
    expect(d.topSignal?.headline).toBe("Blood pressure is holding steady");
    expect(d.briefingLead).toBe(
      "Your blood pressure is holding steady this week.",
    );
  });

  it("prefers the briefing lead for the push line", () => {
    const d = buildDailyDigest(input(), t);
    expect(d.line).toBe("Your blood pressure is holding steady this week.");
  });

  it("falls back to the top-signal headline when there is no paragraph", () => {
    const d = buildDailyDigest(
      input({ briefing: { ...briefing, paragraph: "" } }),
      t,
    );
    expect(d.line).toBe("Blood pressure is holding steady");
  });

  it("falls back to a deterministic score floor when no briefing exists", () => {
    const d = buildDailyDigest(input({ briefing: null }), t);
    expect(d.topSignal).toBeNull();
    expect(d.briefingLead).toBeNull();
    expect(d.line).toBe("Your health score today is 82.");
  });

  it("degrades to the honest all-clear line with neither briefing nor score", () => {
    const d = buildDailyDigest(input({ briefing: null, score: null }), t);
    expect(d.line).toContain("Nothing needs your attention today");
    expect(d.score).toBeNull();
    expect(d.worthALook).toEqual([]);
  });

  it("is a synchronous pure function — repeated calls are identical", () => {
    const first = buildDailyDigest(input(), t);
    const second = buildDailyDigest(input(), t);
    expect(first).toEqual(second);
    // No provider/AI dependency: the composer never returns a promise.
    expect(first).not.toBeInstanceOf(Promise);
  });
});

describe("buildDailyDigest — freshness (provisional/final)", () => {
  it("is final when last night's sleep is in", () => {
    const d = buildDailyDigest(input({ sleepLastSeenDaysAgo: 0 }), t);
    expect(d.phase).toBe("final");
    expect(d.sleepPending).toBe(false);
  });

  it("is provisional when sleep is tracked but last night is not yet in", () => {
    const d = buildDailyDigest(input({ sleepLastSeenDaysAgo: 2 }), t);
    expect(d.phase).toBe("provisional");
    expect(d.sleepPending).toBe(true);
  });

  it("is provisional when sleep has never been recorded", () => {
    const d = buildDailyDigest(input({ sleepLastSeenDaysAgo: null }), t);
    expect(d.sleepPending).toBe(true);
  });

  it("is final (not pending) when the sleep module is off", () => {
    const d = buildDailyDigest(
      input({ modules: { sleep: false }, sleepLastSeenDaysAgo: null }),
      t,
    );
    expect(d.phase).toBe("final");
    expect(d.sleepPending).toBe(false);
  });
});

describe("buildDailyDigest — worth-a-look rail item builders", () => {
  it("emits a dose-window item when a dose is overdue and medications is on", () => {
    const d = buildDailyDigest(
      input({
        medsToday: meds({
          nextDueOverdue: true,
          nextDueMedicationName: "Ramipril",
        }),
      }),
      t,
    );
    const dose = d.worthALook.find((i) => i.kind === "dose_window");
    expect(dose).toBeDefined();
    expect(dose?.status).toBe("warning");
    expect(dose?.moduleKey).toBe("medications");
    expect(dose?.title).toBe("Medication due");
    expect(dose?.body).toBe("Ramipril is due today.");
    expect(dose?.actions).toHaveLength(1);
    expect(dose?.actions[0].intent).toBe("dose.log");
  });

  it("does NOT emit a dose-window item when the medications module is off", () => {
    const d = buildDailyDigest(
      input({
        modules: { medications: false },
        medsToday: meds({
          nextDueOverdue: true,
          nextDueMedicationName: "Ramipril",
        }),
      }),
      t,
    );
    expect(d.worthALook.some((i) => i.kind === "dose_window")).toBe(false);
  });

  it("does NOT emit a dose-window item when nothing is overdue", () => {
    const d = buildDailyDigest(
      input({ medsToday: meds({ nextDueOverdue: false }) }),
      t,
    );
    expect(d.worthALook.some((i) => i.kind === "dose_window")).toBe(false);
  });

  it("maps one sync-issue item per broken integration", () => {
    const d = buildDailyDigest(
      input({
        syncIssues: [
          { integration: "withings", state: "error_reauth" },
          { integration: "moodlog", state: "parked" },
        ],
      }),
      t,
    );
    const sync = d.worthALook.filter((i) => i.kind === "sync_issue");
    expect(sync).toHaveLength(2);
    expect(sync[0].status).toBe("warning");
    expect(sync[0].body).toContain("Withings");
    expect(sync[0].actions[0].href).toBe("/settings/integrations");
  });

  it("summarises a single preventive-care item with the label", () => {
    const d = buildDailyDigest(
      input({ preventiveDue: [{ label: "Blood panel" }] }),
      t,
    );
    const care = d.worthALook.find((i) => i.kind === "preventive_care");
    expect(care?.status).toBe("info");
    expect(care?.body).toBe("Blood panel is due.");
  });

  it("summarises many preventive-care items into one counted item", () => {
    const d = buildDailyDigest(
      input({
        preventiveDue: [{ label: "A" }, { label: "B" }, { label: "C" }],
      }),
      t,
    );
    const care = d.worthALook.filter((i) => i.kind === "preventive_care");
    expect(care).toHaveLength(1);
    expect(care[0].body).toBe("3 check-ups are due.");
  });

  it("bounds the rail at three items, never padded", () => {
    const d = buildDailyDigest(
      input({
        medsToday: meds({ nextDueOverdue: true, nextDueMedicationName: "X" }),
        syncIssues: [
          { integration: "withings", state: "error_reauth" },
          { integration: "moodlog", state: "parked" },
          { integration: "fitbit", state: "error_reauth" },
        ],
        preventiveDue: [{ label: "Blood panel" }],
      }),
      t,
    );
    expect(d.worthALook.length).toBeLessThanOrEqual(MAX_WORTH_A_LOOK);
    expect(d.worthALook.length).toBe(3);
  });

  it("returns an empty rail when nothing needs attention", () => {
    const d = buildDailyDigest(input(), t);
    expect(d.worthALook).toEqual([]);
  });
});
