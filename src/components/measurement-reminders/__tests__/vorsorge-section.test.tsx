import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import type { MeasurementReminder } from "@/hooks/use-measurement-reminders";

/**
 * v1.17.1 — the Vorsorge section's loading + empty affordances.
 *
 * Audit 02-H1/H2 + 11-H1: the list read `isLoading` but rendered nothing while
 * fetching (a header over blank space). The fix paints a tile-shaped `Skeleton`
 * stack while loading and routes the no-data case through the shared
 * `<EmptyState>` with an add action. These tests pin both.
 */

const remindersMock = vi.fn();
vi.mock("@/hooks/use-measurement-reminders", () => ({
  useMeasurementReminders: () => remindersMock(),
  useMeasurementReminderMutations: () => ({
    create: { mutate: vi.fn(), isPending: false },
    update: { mutate: vi.fn(), isPending: false },
    remove: { mutate: vi.fn(), isPending: false },
    satisfy: { mutate: vi.fn(), isPending: false },
  }),
}));

import { VorsorgeSection } from "../vorsorge-section";

function render(node: React.ReactNode) {
  // v1.18.7 (Wave E) — a measurement-linked card now mounts the 7-day
  // trend strip, which reads via TanStack Query; wrap in a client so the
  // static-markup render resolves (the query stays idle on the server).
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en">{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  remindersMock.mockReset();
});

describe("<VorsorgeSection> loading + empty", () => {
  it("paints the shared Skeleton stack while loading", () => {
    remindersMock.mockReturnValue({ data: undefined, isLoading: true });
    const html = render(<VorsorgeSection />);
    expect(html).toContain('data-slot="vorsorge-loading"');
    expect(html).toContain('data-slot="skeleton"');
    // No empty-state while still loading.
    expect(html).not.toContain('data-slot="empty-state"');
  });

  it("routes the no-data case through the shared EmptyState with an action", () => {
    remindersMock.mockReturnValue({ data: [], isLoading: false });
    const html = render(<VorsorgeSection />);
    expect(html).toContain('data-slot="empty-state"');
    expect(html).toContain("border-dashed");
    expect(html).not.toContain('data-slot="vorsorge-loading"');
  });

  it("renders reminder cards once data lands", () => {
    const reminder: MeasurementReminder = {
      id: "r1",
      label: "Annual blood panel",
      measurementType: null,
      intervalDays: 365,
      rrule: null,
      nextDueAt: null,
      notifyHour: 9,
      location: null,
      enabled: true,
    } as MeasurementReminder;
    remindersMock.mockReturnValue({ data: [reminder], isLoading: false });
    const html = render(<VorsorgeSection />);
    expect(html).toContain("Annual blood panel");
    expect(html).not.toContain('data-slot="empty-state"');
    expect(html).not.toContain('data-slot="vorsorge-loading"');
  });

  it("renders a 'Measure now' action for a measurement-linked reminder", () => {
    // v1.18.2 — a typed reminder's primary action opens the value-entry form.
    // v1.18.6 (MOD-06) — surfaced as a green "Measure now" button (a
    // measurement is not an intake), not a silent checkmark.
    const reminder: MeasurementReminder = {
      id: "linked",
      label: "Measure blood pressure",
      measurementType: "BLOOD_PRESSURE_SYS",
      intervalDays: 7,
      rrule: null,
      anchorDate: null,
      endsOn: null,
      origin: "VORSORGE",
      nextDueAt: null,
      notifyHour: 9,
      location: null,
      lastSatisfiedAt: null,
      enabled: true,
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:00:00.000Z",
    } as MeasurementReminder;
    remindersMock.mockReturnValue({ data: [reminder], isLoading: false });
    const html = render(<VorsorgeSection />);
    expect(html).toContain("Measure now");
    expect(html).not.toContain(">Done<");
  });

  it("renders a 'Done' action for a free-text / self-planned reminder", () => {
    // v1.18.2 — a free-text reminder keeps the silent satisfy, surfaced as
    // a "Done" button + the "Self-planned" category badge.
    const reminder: MeasurementReminder = {
      id: "planned",
      label: "Annual physical",
      measurementType: null,
      intervalDays: 365,
      rrule: null,
      anchorDate: null,
      endsOn: null,
      origin: "VORSORGE",
      nextDueAt: null,
      notifyHour: 9,
      location: null,
      lastSatisfiedAt: null,
      enabled: true,
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:00:00.000Z",
    } as MeasurementReminder;
    remindersMock.mockReturnValue({ data: [reminder], isLoading: false });
    const html = render(<VorsorgeSection />);
    expect(html).toContain("Done");
    expect(html).toContain("Self-planned");
    expect(html).not.toContain("Log value");
  });

  it("reads a same-day due time as 'today' (calendar-day delta, not rolling 24h)", () => {
    // v1.18.9 recon — a reminder whose nextDue falls on the SAME local
    // calendar day must read "Due today" with the green status hue, even when
    // the wall-clock gap to now exceeds the 24h a rolling delta would key on.
    // Anchor the due instant to local noon today so the floored calendar-day
    // delta is 0 regardless of the hour the suite runs.
    const todayNoon = new Date();
    todayNoon.setHours(12, 0, 0, 0);
    const reminder: MeasurementReminder = {
      id: "due-today",
      label: "Blood pressure check",
      measurementType: "BLOOD_PRESSURE_SYS",
      intervalDays: 7,
      rrule: null,
      anchorDate: null,
      endsOn: null,
      origin: "VORSORGE",
      nextDueAt: todayNoon.toISOString(),
      notifyHour: 9,
      location: null,
      lastSatisfiedAt: null,
      enabled: true,
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:00:00.000Z",
    } as MeasurementReminder;
    remindersMock.mockReturnValue({ data: [reminder], isLoading: false });
    const html = render(<VorsorgeSection />);
    expect(html).toContain("Due today");
    // The status hue is the discreet success colour, never a card-bg tint.
    expect(html).toContain("text-success");
  });

  it("reads a prior-day due time as 'overdue' once the calendar day has passed", () => {
    // A reminder whose due CALENDAR day is before today reads "Overdue", with
    // the warning hue — a rolling-24h delta would mis-bucket a yesterday-evening
    // due viewed this morning as "today".
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(20, 0, 0, 0);
    const reminder: MeasurementReminder = {
      id: "overdue",
      label: "Annual physical",
      measurementType: null,
      intervalDays: 365,
      rrule: null,
      anchorDate: null,
      endsOn: null,
      origin: "VORSORGE",
      nextDueAt: yesterday.toISOString(),
      notifyHour: 9,
      location: null,
      lastSatisfiedAt: null,
      enabled: true,
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:00:00.000Z",
    } as MeasurementReminder;
    remindersMock.mockReturnValue({ data: [reminder], isLoading: false });
    const html = render(<VorsorgeSection />);
    expect(html).toContain("Overdue by 1 days");
    expect(html).toContain("text-warning");
  });

  it("translates a COACH-origin label i18n key and shows the neutral badge", () => {
    const reminder: MeasurementReminder = {
      id: "c1",
      // A COACH row stores the cadence preset's i18n KEY in `label`.
      label: "coach.reminderSuggestion.cadence.bp722",
      measurementType: "BLOOD_PRESSURE_SYS",
      intervalDays: null,
      rrule: "FREQ=DAILY;BYHOUR=7,19;INTERVAL=1",
      anchorDate: null,
      endsOn: "2030-01-08T00:00:00.000Z",
      origin: "COACH",
      nextDueAt: null,
      notifyHour: 7,
      location: null,
      lastSatisfiedAt: null,
      enabled: true,
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:00:00.000Z",
    } as MeasurementReminder;
    remindersMock.mockReturnValue({ data: [reminder], isLoading: false });
    const html = render(<VorsorgeSection />);
    // The raw i18n key must never leak; the resolved EN string shows instead.
    expect(html).not.toContain("coach.reminderSuggestion.cadence.bp722");
    expect(html).toContain(
      "Measure your blood pressure twice a day for a week",
    );
    // Neutral "Coach" provenance badge + an "until <date>" course line.
    expect(html).toContain("Coach");
    expect(html).toContain("Until");
  });
});
