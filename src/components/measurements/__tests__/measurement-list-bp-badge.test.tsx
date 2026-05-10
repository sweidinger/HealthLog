import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * v1.4.19 — Sys/Dia badge enum-mismatch regression guard.
 *
 * The mobile-list BP-type badge must check the canonical
 * `BLOOD_PRESSURE_SYS` / `BLOOD_PRESSURE_DIA` enum values (matching
 * `prisma/schema.prisma` and `MEASUREMENT_TYPE_LABEL_KEYS`). An earlier
 * implementation checked `BP_SYS` / `BP_DIA` — short forms that never
 * appear in the API payload — so the badge silently never painted on
 * mobile. The desktop table was unaffected because it routes through
 * `MEASUREMENT_TYPE_LABEL_KEYS[m.type]`.
 *
 * This guard renders the mobile list with one systolic + one diastolic
 * row and asserts both labels show up.
 */

const baseMeasurements = [
  {
    id: "m-sys-1",
    type: "BLOOD_PRESSURE_SYS",
    value: 117,
    unit: "mmHg",
    source: "MANUAL",
    measuredAt: "2026-05-09T08:30:00.000Z",
    notes: null,
  },
  {
    id: "m-dia-1",
    type: "BLOOD_PRESSURE_DIA",
    value: 78,
    unit: "mmHg",
    source: "MANUAL",
    measuredAt: "2026-05-09T08:30:00.000Z",
    notes: null,
  },
];

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/measurements",
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: { measurements: baseMeasurements, meta: { total: 2 } },
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

function render(locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <MeasurementList />
    </I18nProvider>,
  );
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count += 1;
    idx += needle.length;
  }
  return count;
}

describe("MeasurementList — Sys/Dia disambiguation badge (mobile list)", () => {
  // Both desktop table + mobile card list render in static markup
  // (responsive switching is purely CSS), so each label must appear
  // twice — once per branch — when the badge is wired correctly.

  it("renders the Sys badge in BOTH desktop table and mobile list", () => {
    const html = render("en");
    expect(countOccurrences(html, ">Sys<")).toBe(2);
  });

  it("renders the Dia badge in BOTH desktop table and mobile list", () => {
    const html = render("en");
    expect(countOccurrences(html, ">Dia<")).toBe(2);
  });

  it("renders Sys + Dia in both branches under the German locale too", () => {
    const html = render("de");
    expect(countOccurrences(html, ">Sys<")).toBe(2);
    expect(countOccurrences(html, ">Dia<")).toBe(2);
  });
});
