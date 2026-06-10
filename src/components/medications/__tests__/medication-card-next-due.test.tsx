import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { MedicationCard } from "@/components/medications/medication-card";

/**
 * v1.8.4 — the generic medication card must render the server-computed
 * `nextDueAt` (canonical recurrence engine, anchored on the last intake)
 * as the "next intake" timestamp, NOT a client-side daysOfWeek walker.
 *
 * The legacy walker only read `daysOfWeek` + `windowStart` and ignored
 * rolling / RRULE / one-shot cadences, so a rolling medication (e.g.
 * `rollingIntervalDays = 35`) wrongly read "tomorrow" and never
 * re-anchored after an intake. These tests pin that the card now
 * surfaces the server value, while the day-label / window-range
 * rendering for ordinary single-time schedules is unchanged.
 */

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: Infinity },
    },
  });
}

function render(node: React.ReactNode, client: QueryClient) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </I18nProvider>,
  );
}

function seedCompliance(client: QueryClient, medId: string) {
  client.setQueryData(["medications", medId, "compliance"], {
    compliance7: { rate: 90, streak: 0, totalExpected: 7, taken: 6 },
    compliance30: { rate: 88 },
  });
}

// A schedule whose window has already passed for today (01:00–02:00) so
// the card surfaces the "next intake" line rather than the take-now
// pill, regardless of host clock.
const pastWindow = {
  windowStart: "01:00",
  windowEnd: "02:00",
  label: null,
  daysOfWeek: null,
  dose: null,
};

// Pin the clock to a fixed mid-day instant so window-status ("take now"
// vs "next intake") and relative day labels are deterministic regardless
// of the CI host clock + timezone. The 01:00–02:00 windows below read as
// inactive at noon in every timezone; an unpinned run that happened to
// fall inside that window (e.g. 01:01 CEST) flipped the card to the
// take-now pill and broke these assertions.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("<MedicationCard> — next-due reads from server nextDueAt", () => {
  it("renders the server nextDueAt date for a rolling medication, not a today/tomorrow walker value", () => {
    // Rolling cadence: server anchors the next dose 35 days out. The
    // card must surface that calendar date — the legacy walker would
    // have produced "tomorrow" off the schedule window alone.
    const now = new Date();
    const due = new Date(now);
    due.setDate(due.getDate() + 35);
    // Midday so the Berlin display can't cross a day boundary regardless
    // of the host timezone.
    due.setHours(12, 0, 0, 0);

    const rollingMed = {
      id: "med-rolling-1",
      name: "Mounjaro",
      dose: "7.5 mg",
      category: "OTHER",
      treatmentClass: undefined as string | undefined,
      active: true,
      notificationsEnabled: true,
      pausedAt: null,
      lastTakenAt: null,
      todayEventCount: 0,
      nextDueAt: due.toISOString(),
      schedules: [{ id: "s-rolling-1", ...pastWindow }],
    };

    const client = makeClient();
    seedCompliance(client, rollingMed.id);

    const html = render(
      <MedicationCard
        medication={rollingMed}
        onEdit={() => {}}
        onOpenHistory={() => {}}
      />,
      client,
    );

    // The next-intake line surfaces.
    expect(html).toContain("Next intake:");
    // 35 days out is past the 5-day threshold, so the card renders the
    // full weekday-anchored short date (e.g. "Mon, 07/06") derived from
    // the SERVER instant — NOT a today/tomorrow walker value. Pin the
    // day-of-month + month of the SERVER date (Berlin-rendered), proving
    // the date tracks `nextDueAt` rather than the schedule window alone.
    const berlin = new Intl.DateTimeFormat("en", {
      timeZone: "Europe/Berlin",
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
    }).format(due);
    expect(html).toContain(berlin);
    expect(html).not.toContain("Next intake: Today,");
    expect(html).not.toContain("Next intake: Tomorrow,");
  });

  it("falls back to the schedule window range when nextDueAt is absent", () => {
    // A medication with no server next-due (e.g. ended course) still
    // renders the window-range line off its first schedule; it just
    // omits the day label.
    const med = {
      id: "med-nodue-1",
      name: "Ramipril",
      dose: "5 mg",
      category: "BLOOD_PRESSURE",
      treatmentClass: undefined as string | undefined,
      active: true,
      notificationsEnabled: true,
      pausedAt: null,
      lastTakenAt: null,
      todayEventCount: 0,
      nextDueAt: null,
      schedules: [{ id: "s-nodue-1", ...pastWindow }],
    };

    const client = makeClient();
    seedCompliance(client, med.id);

    const html = render(
      <MedicationCard
        medication={med}
        onEdit={() => {}}
        onOpenHistory={() => {}}
      />,
      client,
    );

    expect(html).toContain("Next intake:");
    // No day label is prepended when the server gave no instant — the
    // line goes straight to the window range.
    expect(html).not.toContain("Next intake: Today,");
    expect(html).not.toContain("Next intake: Tomorrow,");
  });

  it("renders the day label for a single-time daysOfWeek medication due tomorrow", () => {
    // A daily / weekly medication whose server next-due is tomorrow
    // still renders the relative "tomorrow" label — proving the ordinary
    // single-time path keeps working. `due` is a fixed UTC instant ~20h
    // after the pinned clock, so it lands on the next calendar day in both
    // UTC and the Berlin default — the relative label is deterministic.
    const now = new Date();
    const due = new Date(now);
    due.setUTCDate(due.getUTCDate() + 1);
    due.setUTCHours(8, 0, 0, 0);

    const med = {
      id: "med-daily-1",
      name: "Ramipril",
      dose: "5 mg",
      category: "BLOOD_PRESSURE",
      treatmentClass: undefined as string | undefined,
      active: true,
      notificationsEnabled: true,
      pausedAt: null,
      lastTakenAt: null,
      todayEventCount: 0,
      nextDueAt: due.toISOString(),
      schedules: [
        {
          id: "s-daily-1",
          windowStart: "08:00",
          windowEnd: "09:00",
          label: null,
          daysOfWeek: null,
          dose: "5 mg",
        },
      ],
    };

    const client = makeClient();
    seedCompliance(client, med.id);

    const html = render(
      <MedicationCard
        medication={med}
        onEdit={() => {}}
        onOpenHistory={() => {}}
      />,
      client,
    );

    expect(html).toContain("Next intake:");
    // Relative day label from the server instant (capitalised "Tomorrow").
    expect(html).toContain("Tomorrow,");
  });
});
