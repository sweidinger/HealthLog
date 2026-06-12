/**
 * v1.16.10 — /medications view-toggle wiring.
 *
 * Pins that the page renders the view the PERSISTED preference names
 * (cards vs table from `GET /api/medications/layout`, seeded into the
 * query cache), that the header toggle announces the active segment,
 * and that the manual medication order applies to BOTH views. The PUT
 * side of the persistence contract is pinned in
 * `src/lib/queries/__tests__/use-medication-list-layout.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
    user: { timezone: "Europe/Berlin" },
  }),
}));

// The create wizard and the dialogs are closed in every assertion here;
// mock them away so the page render stays scoped to the list surface.
vi.mock("@/components/medications/wizard/MedicationWizardDialog", () => ({
  MedicationWizardDialog: () => null,
}));
vi.mock("@/components/medications/log-intake-dialog", () => ({
  LogIntakeDialog: () => null,
}));
vi.mock("@/components/medications/medication-reorder-dialog", () => ({
  MedicationReorderDialog: () => null,
}));

import MedicationsPage from "@/app/medications/page";
import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import type { MedicationListLayout } from "@/lib/medication-list-layout";

const pastWindow = {
  windowStart: "01:00",
  windowEnd: "02:00",
  label: null,
  daysOfWeek: null,
  dose: null,
};

const MEDS = [
  {
    id: "m1",
    name: "Ramipril",
    dose: "5 mg",
    category: "OTHER",
    active: true,
    notificationsEnabled: true,
    pausedAt: null,
    lastTakenAt: null,
    todayEventCount: 0,
    nextDueAt: null,
    nextDueOverdue: false,
    stockDosesRemaining: null,
    schedules: [{ id: "s1", ...pastWindow }],
  },
  {
    id: "m2",
    name: "Aspirin",
    dose: "100 mg",
    category: "OTHER",
    active: true,
    notificationsEnabled: true,
    pausedAt: null,
    lastTakenAt: null,
    todayEventCount: 0,
    nextDueAt: null,
    nextDueOverdue: false,
    stockDosesRemaining: null,
    schedules: [{ id: "s2", ...pastWindow }],
  },
];

function renderPage(layout: MedicationListLayout): string {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: Infinity },
    },
  });
  client.setQueryData(queryKeys.medications(), MEDS);
  client.setQueryData(queryKeys.medicationListLayout(), layout);
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <QueryClientProvider client={client}>
        <MedicationsPage />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("/medications — view renders from the persisted preference", () => {
  it("renders the card grid for view=cards and announces the active segment", () => {
    const html = renderPage({ version: 1, view: "cards", order: [] });

    expect(html).not.toContain("<table");
    expect(html).toContain('data-slot="card"');
    // Toggle present, group named, the cards segment pressed.
    expect(html).toContain('aria-label="View"');
    expect(html).toMatch(
      /data-slot="medications-view-cards"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-slot="medications-view-cards"/,
    );
    expect(html).toMatch(
      /data-slot="medications-view-table"[^>]*aria-pressed="false"|aria-pressed="false"[^>]*data-slot="medications-view-table"/,
    );
  });

  it("renders the table for view=table", () => {
    const html = renderPage({ version: 1, view: "table", order: [] });

    expect(html).toContain("<table");
    expect(html).toMatch(
      /data-slot="medications-view-table"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-slot="medications-view-table"/,
    );
  });

  it("offers the manual-order editor from the header", () => {
    const html = renderPage({ version: 1, view: "cards", order: [] });
    expect(html).toContain('aria-label="Adjust order"');
  });
});

describe("/medications — the manual order applies to BOTH views", () => {
  // Alphabetical default would put Aspirin first; the saved order pins
  // Ramipril to the top. Both views must follow it.
  const layout: MedicationListLayout = {
    version: 1,
    view: "cards",
    order: ["m1", "m2"],
  };

  it("orders the cards by the saved order", () => {
    const html = renderPage(layout);
    expect(html.indexOf("Ramipril")).toBeLessThan(html.indexOf("Aspirin"));
  });

  it("orders the table rows by the saved order", () => {
    const html = renderPage({ ...layout, view: "table" });
    expect(html.indexOf("Ramipril")).toBeLessThan(html.indexOf("Aspirin"));
  });

  it("falls back to the alphabetical default without a saved order", () => {
    const html = renderPage({ version: 1, view: "cards", order: [] });
    expect(html.indexOf("Aspirin")).toBeLessThan(html.indexOf("Ramipril"));
  });
});
