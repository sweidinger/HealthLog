import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

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
    remove: { mutate: vi.fn(), isPending: false },
    satisfy: { mutate: vi.fn(), isPending: false },
  }),
}));

import { VorsorgeSection } from "../vorsorge-section";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
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
});
