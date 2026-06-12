/**
 * v1.16.10 — Bestand summary availability semantics.
 *
 * Renders `<InventorySection>` with a seeded query cache and pins the
 * release-QA scenario: a single EXPIRED pen with units left shows ZERO
 * available doses in the headline, with the expired units as a muted
 * suffix — matching the list payload and the GLP-1 endpoint instead of
 * counting expired stock as supply.
 *
 * Project convention is SSR-only component tests (`renderToStaticMarkup`).
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

const useQueryMock = vi.fn();

vi.mock("@tanstack/react-query", () => ({
  useQuery: (...args: unknown[]) => useQueryMock(...args),
  useQueryClient: () => ({
    invalidateQueries: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const { InventorySection } = await import("../sections/inventory-section");

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="de">{node}</I18nProvider>,
  );
}

function seedItems(items: unknown[]) {
  useQueryMock.mockReturnValue({
    data: { items, meta: { total: items.length } },
    isLoading: false,
  });
}

describe("<InventorySection> — summary availability", () => {
  it("one expired pen with units ⇒ headline 0, expired units as muted suffix", () => {
    seedItems([
      {
        id: "i1",
        state: "EXPIRED",
        containerType: "PEN",
        unitsTotal: 4,
        unitsRemaining: 4,
      },
    ]);
    const html = render(
      <InventorySection medicationId="med-1" unitsPerDose={1} />,
    );
    expect(html).toContain("0 von 0 Dosen übrig");
    expect(html).toContain('data-slot="inventory-expired-suffix"');
    expect(html).toContain("+ 4 Einheiten abgelaufen");
    // The item row itself stays visible with its state badge.
    expect(html).toContain("Abgelaufen");
  });

  it("usable stock counts; expired suffix absent when nothing expired", () => {
    seedItems([
      {
        id: "i1",
        state: "ACTIVE",
        containerType: "PEN",
        unitsTotal: 4,
        unitsRemaining: 4,
      },
      {
        id: "i2",
        state: "USED_UP",
        containerType: "PEN",
        unitsTotal: 4,
        unitsRemaining: 0,
      },
    ]);
    const html = render(
      <InventorySection medicationId="med-1" unitsPerDose={1} />,
    );
    expect(html).toContain("4 von 4 Dosen übrig");
    expect(html).not.toContain('data-slot="inventory-expired-suffix"');
  });

  it("mixed usable + expired: headline counts only the usable pool", () => {
    seedItems([
      {
        id: "i1",
        state: "IN_USE",
        containerType: "PEN",
        unitsTotal: 4,
        unitsRemaining: 2,
      },
      {
        id: "i2",
        state: "EXPIRED",
        containerType: "PEN",
        unitsTotal: 4,
        unitsRemaining: 3,
      },
    ]);
    const html = render(
      <InventorySection medicationId="med-1" unitsPerDose={1} />,
    );
    expect(html).toContain("2 von 4 Dosen übrig");
    expect(html).toContain("+ 3 Einheiten abgelaufen");
  });
});
