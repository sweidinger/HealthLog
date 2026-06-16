import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { I18nProvider } from "@/lib/i18n/context";
import { makeFormatters } from "@/lib/format-locale";
import type { DashboardSnapshot } from "@/lib/dashboard/snapshot";
import type { MedsTodayBlock } from "@/lib/dashboard/meds-today";
import type { DataSummary } from "@/lib/analytics/trends";
import { DashboardHero } from "../dashboard-hero";

/**
 * `<DashboardHero>` contract:
 *
 *   - every verdict variant renders its sentence + the single CTA the
 *     ladder assigns (link variants carry an href, quick-entry variants
 *     a button; allQuiet carries none);
 *   - the briefing rung renders the model headline VERBATIM as plain
 *     text (no i18n key);
 *   - the dose row prints the day tally with next-at / all-done / none
 *     detail, and the documented stale-cache state (past `nextDueAt`,
 *     `nextDueOverdue: false`) renders as the plain summary — never as
 *     overdue;
 *   - the greeting derives from the snapshot's server-computed
 *     `greetingHour` and personalises from the snapshot username;
 *   - the right column always paints the `sm` ScoreRing — provisional
 *     (never "0") when the score is null.
 *
 * The component reads the wall clock (`new Date()`) to age the cached
 * snapshot honestly, so the suite pins the system time; the snapshot's
 * own timezone (`Europe/Berlin`) keeps every assertion independent of
 * the host zone.
 */

const NOW = new Date("2026-06-10T10:00:00.000Z"); // 12:00 Europe/Berlin

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function summary(partial: Partial<DataSummary>): DataSummary {
  return {
    count: 0,
    latest: null,
    min: null,
    max: null,
    mean: null,
    median: null,
    avg7: null,
    avg30: null,
    slope7: null,
    slope30: null,
    slope90: null,
    anomalyCount: 0,
    ...partial,
  };
}

function medsToday(partial: Partial<MedsTodayBlock> = {}): MedsTodayBlock {
  return {
    activeCount: 0,
    scheduledToday: 0,
    takenToday: 0,
    skippedToday: 0,
    nextDueAt: null,
    nextDueOverdue: false,
    nextDueMedicationName: null,
    ...partial,
  };
}

function baseSnapshot(
  overrides: Partial<DashboardSnapshot> = {},
): DashboardSnapshot {
  return {
    user: {
      username: "tester",
      timezone: "Europe/Berlin",
      heightCm: null,
      dateOfBirth: null,
      gender: null,
      glucoseUnit: null,
      onboardingTourCompleted: true,
      greetingHour: 12,
    },
    layout: { version: 1, widgets: [] },
    layoutCatalogue: [],
    metricStates: {},
    tiles: {
      summaries: {},
      lastSeenByType: {},
      mood: { summary: null, entries: [] },
    },
    extras: null,
    medsToday: medsToday(),
    healthScore: null,
    briefing: null,
    briefingState: "preparing",
    briefingUpdatedAt: null,
    briefingStale: false,
    generatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function isoHoursFromNow(hours: number): string {
  return new Date(NOW.getTime() + hours * 60 * 60 * 1000).toISOString();
}

function render(
  snapshot: DashboardSnapshot,
  opts: { locale?: "en" | "de"; onQuickEntry?: () => void } = {},
) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={opts.locale ?? "de"}>
      <DashboardHero
        snapshot={snapshot}
        onQuickEntry={opts.onQuickEntry ?? (() => undefined)}
      />
    </I18nProvider>,
  );
}

describe("<DashboardHero> — verdict variants", () => {
  it("doseOverdue: sentence with the medication name + quick-entry CTA button", () => {
    const html = render(
      baseSnapshot({
        medsToday: medsToday({
          scheduledToday: 2,
          nextDueAt: isoHoursFromNow(-1),
          nextDueOverdue: true,
          nextDueMedicationName: "Metformin",
        }),
      }),
    );
    expect(html).toContain('data-verdict-variant="doseOverdue"');
    expect(html).toContain("Eine Dosis Metformin ist überfällig.");
    expect(html).toContain('data-slot="dashboard-hero-cta"');
    expect(html).toContain("Jetzt eintragen");
    // Quick-entry CTA is a real button, not a link.
    expect(html).toMatch(/<button[^>]*data-slot="dashboard-hero-cta"/);
  });

  it("doseOverdue: a null medication name renders the name-less sentence (no hole)", () => {
    const html = render(
      baseSnapshot({
        medsToday: medsToday({
          scheduledToday: 2,
          nextDueAt: isoHoursFromNow(-1),
          nextDueOverdue: true,
          nextDueMedicationName: null,
        }),
      }),
    );
    expect(html).toContain('data-verdict-variant="doseOverdue"');
    expect(html).toContain("Eine Dosis ist überfällig.");
    // The named template with an empty interpolation leaves a double
    // space — it must never render.
    expect(html).not.toContain("Eine Dosis  ist überfällig.");
  });

  it("doseUpcoming: a null medication name renders the name-less sentence (no hole)", () => {
    const nextDueAt = isoHoursFromNow(1.5); // 13:30 Berlin
    const html = render(
      baseSnapshot({
        medsToday: medsToday({
          scheduledToday: 2,
          takenToday: 1,
          nextDueAt,
          nextDueMedicationName: null,
        }),
      }),
    );
    const expectedTime = makeFormatters("de", "Europe/Berlin", "AUTO").time(
      nextDueAt,
    );
    expect(html).toContain('data-verdict-variant="doseUpcoming"');
    expect(html).toContain(`Um ${expectedTime} steht eine Dosis an.`);
    expect(html).not.toContain(`steht  an`);
  });

  it("bpCritical: fixed-floor sentence with the reading + link to the BP insight", () => {
    const html = render(
      baseSnapshot({
        tiles: {
          summaries: {
            BLOOD_PRESSURE_SYS: summary({ latest: 184, count: 5 }),
            BLOOD_PRESSURE_DIA: summary({ latest: 96, count: 5 }),
          },
          lastSeenByType: {
            BLOOD_PRESSURE_SYS: {
              lastSeenAt: isoHoursFromNow(-2),
              daysAgo: 0,
            },
          },
          mood: { summary: null, entries: [] },
        },
      }),
    );
    expect(html).toContain('data-verdict-variant="bpCritical"');
    expect(html).toContain("sehr hoch (184/96)");
    expect(html).toContain('href="/insights/blood-pressure"');
    expect(html).toContain("Blutdruck ansehen");
  });

  it("doseUpcoming: preference-aware wall-clock time + name + quick-entry CTA", () => {
    const nextDueAt = isoHoursFromNow(1.5); // 13:30 Berlin
    const html = render(
      baseSnapshot({
        medsToday: medsToday({
          scheduledToday: 2,
          takenToday: 1,
          nextDueAt,
          nextDueMedicationName: "Jardiance",
        }),
      }),
    );
    const expectedTime = makeFormatters("de", "Europe/Berlin", "AUTO").time(
      nextDueAt,
    );
    expect(html).toContain('data-verdict-variant="doseUpcoming"');
    expect(html).toContain(`Um ${expectedTime} steht Jardiance an.`);
    expect(html).toContain("Jetzt eintragen");
    // The dose row repeats the same instant as "Nächste um …".
    expect(html).toContain(`Nächste um ${expectedTime}`);
  });

  it("weightDrift: sentence + link to the weight insight", () => {
    const html = render(
      baseSnapshot({
        user: { ...baseSnapshot().user, heightCm: 180 },
        tiles: {
          summaries: {
            // Green range for 180 cm ≈ 59.9–80.7 kg; 7d mean sits 1 kg
            // further outside than the 30d mean.
            WEIGHT: summary({ avg7: 86, avg30: 85, count: 10 }),
          },
          lastSeenByType: {
            WEIGHT: { lastSeenAt: isoHoursFromNow(-3), daysAgo: 0 },
          },
          mood: { summary: null, entries: [] },
        },
      }),
    );
    expect(html).toContain('data-verdict-variant="weightDrift"');
    expect(html).toContain(
      "Dein Gewicht bewegt sich diese Woche vom Zielbereich weg.",
    );
    expect(html).toContain('href="/insights/weight"');
    expect(html).toContain("Gewicht ansehen");
  });

  it("shortNights: locale-formatted hours + link to the sleep insight", () => {
    const html = render(
      baseSnapshot({
        tiles: {
          summaries: {
            // 372 min = 6.2 h — clearly under the 6.5 h fire line.
            SLEEP_DURATION: summary({ avg7: 372, count: 7 }),
          },
          lastSeenByType: {
            SLEEP_DURATION: { lastSeenAt: isoHoursFromNow(-5), daysAgo: 0 },
          },
          mood: { summary: null, entries: [] },
        },
      }),
    );
    expect(html).toContain('data-verdict-variant="shortNights"');
    // German decimal comma via the locale number formatter.
    expect(html).toContain("im Schnitt 6,2 h.");
    expect(html).toContain('href="/insights/sleep"');
    expect(html).toContain("Schlaf ansehen");
  });

  it("silence: day count + quick-entry measurement CTA", () => {
    const html = render(
      baseSnapshot({
        tiles: {
          summaries: {},
          lastSeenByType: {
            WEIGHT: { lastSeenAt: isoHoursFromNow(-9 * 24), daysAgo: 9 },
          },
          mood: { summary: null, entries: [] },
        },
      }),
    );
    expect(html).toContain('data-verdict-variant="silence"');
    expect(html).toContain("Seit 9 Tagen keine Messung.");
    expect(html).toContain("Messung erfassen");
    expect(html).toMatch(/<button[^>]*data-slot="dashboard-hero-cta"/);
  });

  it("scoreDrop: point delta + link to /insights", () => {
    const html = render(
      baseSnapshot({
        healthScore: { score: 58, band: "yellow", delta: -14 },
      }),
    );
    expect(html).toContain('data-verdict-variant="scoreDrop"');
    expect(html).toContain("liegt 14 Punkte unter der Vorwoche.");
    expect(html).toContain('href="/insights"');
    expect(html).toContain("Insights öffnen");
  });

  it("briefing: renders the model headline verbatim as plain text + Insights link", () => {
    const headline = "Systolic crept up over seven days.";
    const html = render(
      baseSnapshot({
        briefingState: "ready",
        briefingStale: false,
        briefingUpdatedAt: NOW.toISOString(),
        briefing: {
          paragraph: "p",
          keyFindings: [
            {
              tone: "watch",
              headline,
              detail: "detail",
              delta: null,
              sourceWindow: "7d",
              sourceMetric: "bp",
            },
          ],
        } as DashboardSnapshot["briefing"],
      }),
    );
    expect(html).toContain('data-verdict-variant="briefing"');
    expect(html).toContain(headline);
    expect(html).toContain('href="/insights"');
    expect(html).toContain("Insights öffnen");
  });

  it("allQuiet: sentence with NO CTA in the band", () => {
    const html = render(baseSnapshot());
    expect(html).toContain('data-verdict-variant="allQuiet"');
    expect(html).toContain("Alles ruhig");
    expect(html).not.toContain('data-slot="dashboard-hero-cta"');
  });

  it("exactly one CTA renders for an actionable verdict", () => {
    const html = render(
      baseSnapshot({
        medsToday: medsToday({
          scheduledToday: 1,
          nextDueOverdue: true,
          nextDueAt: isoHoursFromNow(-1),
          nextDueMedicationName: "Metformin",
        }),
        healthScore: { score: 50, band: "yellow", delta: -20 },
      }),
    );
    const ctas = html.match(/data-slot="dashboard-hero-cta"/g) ?? [];
    expect(ctas).toHaveLength(1);
  });
});

describe("<DashboardHero> — dose row", () => {
  it("prints the day tally with the neutral chip chrome and the Pill icon", () => {
    const html = render(
      baseSnapshot({
        medsToday: medsToday({ scheduledToday: 3, takenToday: 1 }),
      }),
    );
    expect(html).toContain("1 von 3 Dosen genommen");
    const doseRow = html.match(
      /<div[^>]*data-slot="dashboard-hero-doses"[^>]*>/,
    );
    expect(doseRow).not.toBeNull();
    // v1.18.1: chip sits on a neutral muted surface over the plain card —
    // no translucent card tint, no blur, no shadow (the gradient is gone).
    for (const cls of ["bg-muted/50", "border-border/60", "rounded-xl"]) {
      expect(doseRow![0]).toContain(cls);
    }
    expect(doseRow![0]).not.toContain("backdrop-blur");
    expect(doseRow![0]).not.toContain("shadow-sm");
  });

  it("all doses resolved (taken + skipped) → 'Alle Dosen für heute erledigt'", () => {
    const html = render(
      baseSnapshot({
        medsToday: medsToday({
          scheduledToday: 2,
          takenToday: 1,
          skippedToday: 1,
        }),
      }),
    );
    expect(html).toContain("1 von 2 Dosen genommen");
    expect(html).toContain("Alle Dosen für heute erledigt");
    expect(html).not.toContain("Nächste um");
  });

  it("no doses scheduled → 'Heute keine Dosen geplant'", () => {
    const html = render(baseSnapshot());
    expect(html).toContain("Heute keine Dosen geplant");
    expect(html).not.toContain("Dosen genommen");
  });

  it("DEFENSIVE: a stale past nextDueAt with nextDueOverdue false renders the plain summary, never overdue", () => {
    const html = render(
      baseSnapshot({
        medsToday: medsToday({
          scheduledToday: 2,
          takenToday: 1,
          nextDueAt: isoHoursFromNow(-0.5), // anchor passed AFTER build
          nextDueOverdue: false,
          nextDueMedicationName: "Metformin",
        }),
      }),
    );
    expect(html).toContain("1 von 2 Dosen genommen");
    expect(html).not.toContain("Nächste um");
    expect(html).not.toContain("überfällig");
    expect(html).toContain('data-verdict-variant="allQuiet"');
  });

  it("a next-due anchor on TOMORROW's local day stays off the dose row", () => {
    const html = render(
      baseSnapshot({
        medsToday: medsToday({
          scheduledToday: 2,
          takenToday: 1,
          nextDueAt: isoHoursFromNow(20), // 08:00 Berlin tomorrow
          nextDueMedicationName: "Metformin",
        }),
      }),
    );
    expect(html).toContain("1 von 2 Dosen genommen");
    expect(html).not.toContain("Nächste um");
  });
});

describe("<DashboardHero> — greeting", () => {
  it("personalises from the snapshot username with the server greeting hour", () => {
    const html = render(
      baseSnapshot({
        user: { ...baseSnapshot().user, username: "Sam", greetingHour: 8 },
      }),
    );
    expect(html).toContain("Guten Morgen Sam, willkommen zurück.");
  });

  it("falls back to the name-less line when the username is blank", () => {
    const html = render(
      baseSnapshot({
        user: { ...baseSnapshot().user, username: "  ", greetingHour: 20 },
      }),
    );
    expect(html).toContain("Guten Abend, willkommen zurück.");
  });

  it("derives the daypart from greetingHour without any client Intl walk", () => {
    const day = render(
      baseSnapshot({
        user: { ...baseSnapshot().user, greetingHour: 13 },
      }),
    );
    expect(day).toContain("Hallo tester, willkommen zurück.");
  });
});

describe("<DashboardHero> — score column", () => {
  it("renders the sm ScoreRing with the score + band", () => {
    const html = render(
      baseSnapshot({
        healthScore: { score: 82, band: "green", delta: 2 },
      }),
    );
    expect(html).toContain('data-slot="score-ring"');
    expect(html).toContain('data-band="green"');
    expect(html).toContain("Health Score");
  });

  it("null score renders the provisional ring (not 0) at identical geometry", () => {
    const html = render(baseSnapshot({ healthScore: null }));
    expect(html).toContain('data-slot="score-ring"');
    expect(html).toContain('data-provisional="true"');
    expect(html).toContain("Noch nicht genug Daten");
    // The ring announces "not enough data", never a zero value.
    const aria = html.match(
      /<div[^>]*data-slot="score-ring"[^>]*aria-label="([^"]+)"/,
    );
    expect(aria).not.toBeNull();
    expect(aria![1]).not.toMatch(/\b0\b/);
    // Same fixed footprint as the scored state — the column never
    // collapses (the 120 px sm geometry rides an inline style).
    expect(html).toContain("width:120px");
  });

  // A null score on an account that already carries score inputs is a
  // warm-up state (the rollup tier is mid-fold), not a data gap — the
  // copy must say "computing", never "not enough data".
  it("null score WITH existing score inputs renders the computing label, not the data-gap one", () => {
    const html = render(
      baseSnapshot({
        healthScore: null,
        tiles: {
          summaries: { WEIGHT: summary({ count: 12, latest: 80 }) },
          lastSeenByType: {
            WEIGHT: { lastSeenAt: isoHoursFromNow(-2), daysAgo: 0 },
          },
          mood: { summary: null, entries: [] },
        },
      }),
    );
    expect(html).toContain('data-provisional="true"');
    expect(html).toContain("Score wird berechnet");
    expect(html).not.toContain("Noch nicht genug Daten");
  });

  it("active medications alone count as a score input (compliance pillar)", () => {
    const html = render(
      baseSnapshot({
        healthScore: null,
        medsToday: medsToday({ activeCount: 1 }),
      }),
    );
    expect(html).toContain("Score wird berechnet");
    expect(html).not.toContain("Noch nicht genug Daten");
  });

  it("keeps the genuine data-gap label when no score input exists at all", () => {
    // Empty summaries, no mood entries, no active medications — the
    // baseSnapshot. A non-score-pillar summary (steps) must not flip
    // the copy either.
    const html = render(
      baseSnapshot({
        healthScore: null,
        tiles: {
          summaries: { ACTIVITY_STEPS: summary({ count: 30, latest: 9000 }) },
          lastSeenByType: {},
          mood: { summary: null, entries: [] },
        },
      }),
    );
    expect(html).toContain("Noch nicht genug Daten");
    expect(html).not.toContain("Score wird berechnet");
  });
});

describe("<DashboardHero> — typographic hierarchy", () => {
  it("the greeting leads: larger + heavier than the verdict line", () => {
    const html = render(baseSnapshot());
    const greeting = html.match(
      /<p[^>]*data-slot="dashboard-hero-greeting"[^>]*>/,
    );
    expect(greeting).not.toBeNull();
    expect(greeting![0]).toContain("text-lg");
    expect(greeting![0]).toContain("font-semibold");
    expect(greeting![0]).not.toContain("text-muted-foreground");
    const verdict = html.match(
      /<p[^>]*data-slot="dashboard-hero-verdict"[^>]*>/,
    );
    expect(verdict).not.toBeNull();
    // The verdict stays one step down — base size, medium weight.
    expect(verdict![0]).toContain("text-base");
    expect(verdict![0]).toContain("font-medium");
    expect(verdict![0]).not.toContain("font-semibold");
  });
});

describe("<DashboardHero> — source pins", () => {
  const src = readFileSync(
    join(process.cwd(), "src/components/dashboard/hero/dashboard-hero.tsx"),
    "utf8",
  );

  it("quick-entry CTA wires the verdict's target into onQuickEntry", () => {
    expect(src).toMatch(/onClick=\{\(\) => onQuickEntry\(cta\.target\)\}/);
  });

  it("re-derives the verdict with a fresh now per snapshot", () => {
    expect(src).toMatch(/resolveDashboardVerdict\(snapshot,\s*new Date\(\)\)/);
  });

  it("wears the plain card surface — no gradient, no glow", () => {
    // v1.18.1: the band drops the gradient hero treatment and sits on the
    // same `bg-card` + border + radius as the surrounding chart cards.
    expect(src).toContain("bg-card");
    expect(src).toContain("border-border");
    expect(src).toContain("rounded-xl");
    expect(src).not.toContain("hero-gradient");
    expect(src).not.toContain("glow-purple");
  });

  it("renders the score ring flat (no bloom / pulse / sheen / sweep)", () => {
    expect(src).toMatch(/<ScoreRing[^>]*\n(?:[^>]*\n)*?\s*flat\b/);
  });
});
