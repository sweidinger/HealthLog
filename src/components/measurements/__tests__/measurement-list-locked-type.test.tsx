import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * v1.8.5 — `<MeasurementList lockedType>` for the insights "all readings"
 * subpage. When pinned to a type the global type selector is suppressed
 * and every row belongs to that metric; the list still paginates and
 * exposes inline edit/delete (unchanged from the unlocked path).
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/insights/values/WEIGHT",
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: {
      measurements: [
        {
          id: "m1",
          type: "WEIGHT",
          value: 78.4,
          unit: "kg",
          source: "MANUAL",
          measuredAt: "2026-05-30T08:00:00.000Z",
          notes: null,
        },
      ],
      meta: { total: 1 },
    },
    isLoading: false,
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", username: "marc", role: "USER" },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { MeasurementList } from "../measurement-list";

function render(lockedType?: string) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <MeasurementList lockedType={lockedType} />
    </I18nProvider>,
  );
}

describe("MeasurementList — lockedType", () => {
  it("hides the type selector when locked to a metric", () => {
    const locked = render("WEIGHT");
    const unlocked = render();
    // The unlocked list paints the filter trigger; the locked one does
    // not (the metric is fixed by the route).
    expect(unlocked).toContain("Filter by type");
    expect(locked).not.toContain('role="combobox"');
  });

  it("loads the metric's readings", () => {
    const html = render("WEIGHT");
    // The single seeded WEIGHT row renders with its value + unit.
    expect(html).toContain("78.4");
    expect(html).toContain("kg");
  });
});
