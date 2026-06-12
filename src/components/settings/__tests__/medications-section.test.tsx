/**
 * v1.16.10 — the "Medikamente" settings section (`/settings/medications`).
 *
 * Hosts the /medications list customisation following the dashboard /
 * insights pattern: the cards ⇄ table view preference (the shared header
 * toggle, optimistic PUT) plus the manual-order editor INLINE (two
 * grouped sections, explicit Save). SSR smoke assertions, matching the
 * rest of the settings suite — the editor's interactive contract is
 * pinned in `medication-order-editor.test.tsx`, the PUT side in
 * `use-medication-list-layout.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { MedicationListLayout } from "@/lib/medication-list-layout";

const MEDS = [
  { id: "a1", name: "Ramipril", dose: "5 mg", active: true },
  { id: "a2", name: "Aspirin", dose: "100 mg", active: true },
  { id: "i1", name: "Amoxicillin", dose: "500 mg", active: false },
];

// Mutable holder so individual tests can inject a layout into the mocked
// `useQuery` without re-mocking the module.
const queryState: { layout: MedicationListLayout } = {
  layout: { version: 1, view: "cards", order: [] },
};

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (Array.isArray(queryKey) && queryKey[0] === "medication-list-layout") {
      return { data: queryState.layout, isLoading: false };
    }
    if (Array.isArray(queryKey) && queryKey[0] === "medications") {
      return { data: MEDS, isLoading: false };
    }
    return { data: null, isLoading: false };
  },
  useQueryClient: () => ({ setQueryData: vi.fn(), getQueryData: vi.fn() }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/charts/reduced-motion", () => ({
  prefersReducedMotion: () => true,
}));

import { I18nProvider } from "@/lib/i18n/context";
import { MedicationsSection } from "../medications-section";

function render(locale: "en" | "de" = "en"): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <MedicationsSection />
    </I18nProvider>,
  );
}

beforeEach(() => {
  queryState.layout = { version: 1, view: "cards", order: [] };
});

describe("<MedicationsSection> — SSR smoke", () => {
  it("renders the section heading + description via i18n (no raw keys)", () => {
    const html = render();
    expect(html).toContain("settings-section-medications-title");
    expect(html).toContain("List view and medication order.");
    expect(html).not.toContain("settings.sections.");
    expect(html).not.toContain("medications.view");
    expect(html).not.toContain("medications.reorder");
  });

  it("renders the German copy end-to-end", () => {
    const html = render("de");
    expect(html).toContain("Listenansicht und Reihenfolge der Medikamente.");
    expect(html).toContain("Reihenfolge anpassen");
    expect(html).toContain(
      "Wähle, ob deine Medikamente als Karten oder als Tabelle angezeigt werden.",
    );
  });

  it("hosts the view toggle bound to the persisted layout (cards pressed)", () => {
    const html = render();
    expect(html).toMatch(
      /data-slot="medications-view-cards"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-slot="medications-view-cards"/,
    );
    expect(html).toMatch(
      /data-slot="medications-view-table"[^>]*aria-pressed="false"|aria-pressed="false"[^>]*data-slot="medications-view-table"/,
    );
  });

  it("reflects a persisted table view on the toggle", () => {
    queryState.layout = { version: 1, view: "table", order: [] };
    const html = render();
    expect(html).toMatch(
      /data-slot="medications-view-table"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-slot="medications-view-table"/,
    );
  });

  it("renders the order editor INLINE with active rows before inactive", () => {
    const html = render();
    expect(html).toContain('data-slot="medication-order-editor"');
    expect(html).toContain('data-slot="medication-reorder-section-active"');
    expect(html).toContain('data-slot="medication-reorder-section-inactive"');
    const lastActive = Math.max(
      html.indexOf("Ramipril"),
      html.indexOf("Aspirin"),
    );
    expect(lastActive).toBeLessThan(html.indexOf("Amoxicillin"));
  });

  it("feeds the editor the saved order (active block re-sorted by layout.order)", () => {
    // Alphabetical default would put Aspirin first; the saved order pins
    // Ramipril to the top — the editor must open showing exactly what
    // both /medications views render.
    queryState.layout = { version: 1, view: "cards", order: ["a1", "a2"] };
    const html = render();
    expect(html.indexOf("Ramipril")).toBeLessThan(html.indexOf("Aspirin"));
  });
});
