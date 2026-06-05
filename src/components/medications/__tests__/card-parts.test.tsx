import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { MedicationCard } from "@/components/medications/medication-card";
import {
  Glp1MedicationCard,
  type Glp1Medication,
} from "@/components/medications/glp1-medication-card";
import { MedicationComplianceBars } from "@/components/medications/card-parts/medication-compliance-bars";
import { MedicationStatusPill } from "@/components/medications/card-parts/medication-status-pill";
import { MedicationIntakeActions } from "@/components/medications/card-parts/medication-intake-actions";
import { MedicationStateBadges } from "@/components/medications/card-parts/medication-state-badges";
import { MedicationCycleStatus } from "@/components/medications/card-parts/medication-cycle-status";
import type { CurrentCycle } from "@/lib/analytics/compliance";

/**
 * v1.7.2 — the medication-card status pill, compliance bars, intake-action
 * row, and state badges are shared presentational components consumed by
 * both the generic `<MedicationCard>` and the `<Glp1MedicationCard>`. The
 * symmetry between the two variants is now structural (one component, two
 * call sites) rather than two hand-synced JSX blocks.
 *
 * These tests pin the load-bearing seams of the extracted parts and the
 * unified streak/warning token so a regression can't reopen the drift.
 */

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: Infinity },
    },
  });
}

function render(node: React.ReactNode, client?: QueryClient) {
  const tree = client ? (
    <QueryClientProvider client={client}>{node}</QueryClientProvider>
  ) : (
    node
  );
  return renderToStaticMarkup(<I18nProvider initialLocale="en">{tree}</I18nProvider>);
}

describe("medication card-parts — shared presentational components", () => {
  it("compliance bars render the 7d / 30d labels and the day-streak flame", () => {
    const html = render(
      <MedicationComplianceBars rate7={90} rate30={88} streak={5} />,
    );
    expect(html).toContain("7-day compliance");
    expect(html).toContain("30-day compliance");
    expect(html).toContain("90%");
    expect(html).toContain("88%");
    expect(html).toContain("lucide-flame");
    // v1.12.2 — semantic warning token, NOT the Tailwind-stock drift nor the
    // raw Dracula palette token.
    expect(html).toContain("text-warning");
    expect(html).not.toContain("text-orange-400");
    expect(html).not.toContain("text-dracula-orange");
  });

  it("compliance bars scale the row labels to the chosen windows", () => {
    // v1.8.6 — a sparse cadence steps both windows up; the labels follow.
    const html = render(
      <MedicationComplianceBars
        rate7={75}
        rate30={80}
        streak={0}
        shortDays={90}
        longDays={365}
      />,
    );
    expect(html).toContain("90-day compliance");
    expect(html).toContain("365-day compliance");
    expect(html).not.toContain("7-day compliance");
    expect(html).not.toContain("30-day compliance");
  });

  it("compliance bars hide the streak flame when streak is zero", () => {
    const html = render(
      <MedicationComplianceBars rate7={90} rate30={88} streak={0} />,
    );
    expect(html).not.toContain("lucide-flame");
  });

  it("status pill stamps the success token + take-now glyph in window", () => {
    const html = render(
      <MedicationStatusPill
        status="in_window"
        windowStart="08:00"
        windowEnd="20:00"
      />,
    );
    expect(html).toContain("Take now");
    expect(html).toContain("text-success");
    expect(html).toContain("lucide-circle-check");
  });

  it("status pill stamps the warning token + glyph when late (semantic, not Dracula yellow)", () => {
    // v1.12.2 — the middle "late" tier converged off the lone
    // `text-dracula-yellow` stray onto the semantic warning token.
    const html = render(
      <MedicationStatusPill
        status="late"
        windowStart="08:00"
        windowEnd="20:00"
      />,
    );
    expect(html).toContain("text-warning");
    expect(html).not.toContain("text-dracula-yellow");
    expect(html).toContain("lucide-circle-alert");
  });

  it("status pill stamps the destructive token + glyph when very late", () => {
    // v1.12.2 — very-late is the most-urgent tier; it reads as destructive
    // (red) so the pill is a clean success → warning → destructive ramp.
    const html = render(
      <MedicationStatusPill
        status="very_late"
        windowStart="08:00"
        windowEnd="20:00"
      />,
    );
    expect(html).toContain("text-destructive");
    expect(html).toContain("lucide-triangle-alert");
  });

  it("intake actions row carries exactly the take + skip buttons", () => {
    const html = render(
      <MedicationIntakeActions intakeLoading={null} onRecordIntake={() => {}} />,
    );
    expect(html).toContain("lucide-check");
    expect(html).toContain("lucide-skip-forward");
    expect(html).toContain("min-h-11");
  });

  it("state badges surface the without-notification + paused labels", () => {
    const html = render(
      <MedicationStateBadges
        notificationsEnabled={false}
        active={false}
        pausedAt="2026-05-01T08:00:00.000Z"
      />,
    );
    expect(html).toContain("Without notification");
    expect(html).toContain("Paused since");
  });
});

/**
 * v1.14.0 — the open-cycle status line. A calm, rate-decoupled status driven
 * by `currentCycle.state` so a sparse weekly / rolling med between doses
 * surfaces "next dose in N days" / "due today" / "overdue" rather than leaning
 * on a percentage that misreads an on-schedule med as a scary 0%.
 */
describe("medication cycle status — open-cycle line", () => {
  const baseCycle: CurrentCycle = {
    state: "on_track",
    nextDueAt: null,
    graceUntil: null,
    hasClosedCycles: true,
  };

  const DAY_MS = 24 * 60 * 60 * 1000;

  // Pin the clock to a stable Berlin-noon instant (12:00 CEST) so the
  // component's Berlin day-bucketing is deterministic regardless of the CI
  // runner's timezone — a UTC runner near midnight would otherwise read
  // "now" as the next Berlin day and drift every count by one.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T10:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // A future instant exactly N×24 h from the pinned noon, so every offset lands
  // mid-Berlin-day and the whole-day delta is exactly N in any runtime tz.
  function inDays(n: number): Date {
    return new Date(Date.now() + n * DAY_MS);
  }

  it("renders nothing when state is none (PRN / paused / ended)", () => {
    const html = render(
      <MedicationCycleStatus cycle={{ ...baseCycle, state: "none" }} />,
    );
    expect(html).toBe("");
  });

  it("renders the neutral no-closed-cycles state with the dashed glyph", () => {
    const html = render(
      <MedicationCycleStatus
        cycle={{
          ...baseCycle,
          state: "on_track",
          nextDueAt: inDays(3),
          hasClosedCycles: false,
        }}
      />,
    );
    expect(html).toContain("No closed dose cycles yet");
    expect(html).toContain("lucide-circle-dashed");
    expect(html).toContain("text-muted-foreground");
    // never leaks a relative count when there's no closed cycle to anchor.
    expect(html).not.toContain("Next dose in");
  });

  it("on_track several days out reads the relative-day phrasing in success tone", () => {
    const html = render(
      <MedicationCycleStatus
        cycle={{ ...baseCycle, state: "on_track", nextDueAt: inDays(4) }}
      />,
    );
    expect(html).toContain("Next dose in 4 days");
    expect(html).toContain("text-success");
    expect(html).toContain("lucide-circle-check");
  });

  it("on_track reads the same day count when nextDueAt arrives as an ISO string", () => {
    // Over the wire `nextDueAt` is JSON, so it reaches the card as a string
    // even though the type says `Date`. The component must re-hydrate it for
    // the Berlin day-bucketing — a raw string would silently drift the count.
    const iso = inDays(4).toISOString() as unknown as Date;
    const html = render(
      <MedicationCycleStatus
        cycle={{ ...baseCycle, state: "on_track", nextDueAt: iso }}
      />,
    );
    expect(html).toContain("Next dose in 4 days");
  });

  it("on_track one day out reads tomorrow", () => {
    const html = render(
      <MedicationCycleStatus
        cycle={{ ...baseCycle, state: "on_track", nextDueAt: inDays(1) }}
      />,
    );
    expect(html).toContain("Next dose tomorrow");
    expect(html).not.toContain("in 1 days");
  });

  it("on_track later today reads today", () => {
    // Six hours past the pinned noon — still the same Berlin calendar day.
    const later = new Date(Date.now() + 6 * 60 * 60 * 1000);
    const html = render(
      <MedicationCycleStatus
        cycle={{ ...baseCycle, state: "on_track", nextDueAt: later }}
      />,
    );
    expect(html).toContain("Next dose today");
  });

  it("due reads the amber due-today line", () => {
    const html = render(
      <MedicationCycleStatus
        cycle={{
          ...baseCycle,
          state: "due",
          nextDueAt: new Date(),
          graceUntil: inDays(0),
        }}
      />,
    );
    expect(html).toContain("Due today");
    expect(html).toContain("text-warning");
    expect(html).toContain("lucide-calendar-clock");
  });

  it("missed reads the destructive overdue line", () => {
    const html = render(
      <MedicationCycleStatus
        cycle={{
          ...baseCycle,
          state: "missed",
          nextDueAt: inDays(-3),
          graceUntil: inDays(-3),
        }}
      />,
    );
    expect(html).toContain("Overdue");
    expect(html).toContain("text-destructive");
    expect(html).toContain("lucide-triangle-alert");
  });
});

/**
 * Cross-variant streak-token parity: with a positive streak seeded, the
 * flame on BOTH the generic and the GLP-1 card resolves to the semantic
 * `text-warning` token (v1.12.2), and neither carries the legacy
 * `text-orange-400` nor the raw `text-dracula-orange`.
 */
describe("streak-token parity — generic vs GLP-1 card", () => {
  const ramipril = {
    id: "med-ramipril-streak",
    name: "Ramipril",
    dose: "5 mg",
    category: "BLOOD_PRESSURE",
    treatmentClass: undefined as string | undefined,
    active: true,
    notificationsEnabled: true,
    pausedAt: null,
    lastTakenAt: null,
    todayEventCount: 0,
    schedules: [
      {
        id: "s-ramipril-streak",
        windowStart: "00:00",
        windowEnd: "23:59",
        label: null,
        daysOfWeek: null,
        dose: "5 mg",
      },
    ],
  };

  const mounjaro: Glp1Medication = {
    id: "med-mounjaro-streak",
    name: "Mounjaro",
    dose: "7.5 mg",
    category: "HORMONE",
    treatmentClass: "GLP1",
    dosesPerUnit: 4,
    active: true,
    notificationsEnabled: true,
    pausedAt: null,
    lastTakenAt: null,
    todayEventCount: 0,
    schedules: [
      {
        id: "s-mounjaro-streak",
        windowStart: "00:00",
        windowEnd: "23:59",
        label: null,
        daysOfWeek: null,
        dose: "7.5 mg",
      },
    ],
  };

  function seedStreak(client: QueryClient, medId: string) {
    client.setQueryData(["medications", medId, "compliance"], {
      compliance7: { rate: 90, streak: 4, totalExpected: 7, taken: 6 },
      compliance30: { rate: 88 },
    });
  }

  it("both cards render the flame with the canonical token, never the drift", () => {
    const client = makeClient();
    seedStreak(client, ramipril.id);
    seedStreak(client, mounjaro.id);
    client.setQueryData(["medications", mounjaro.id, "glp1-details"], {
      doseChanges: [],
      recentIntakes: [],
      inventory: null,
    });

    const ramiprilHtml = render(
      <MedicationCard
        medication={ramipril}
        onEdit={() => {}}
        onOpenHistory={() => {}}
        onOpenAdvanced={() => {}}
      />,
      client,
    );
    const mounjaroHtml = render(
      <Glp1MedicationCard
        medication={mounjaro}
        onEdit={() => {}}
        onOpenHistory={() => {}}
        onOpenAdvanced={() => {}}
      />,
      client,
    );

    for (const html of [ramiprilHtml, mounjaroHtml]) {
      expect(html).toContain("lucide-flame");
      expect(html).toContain("text-warning");
      expect(html).not.toContain("text-orange-400");
      expect(html).not.toContain("text-dracula-orange");
    }
  });
});
