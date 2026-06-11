import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
// vi.doMock below invalidates the module registry, so the re-imported
// provider gets a fresh (unprimed) locale cache — pass the DE bundle
// explicitly instead of relying on the vitest.setup.ts seeding.
import deMessages from "../../../../messages/de.json";

/**
 * v1.16.8 — failed chart queries must look like ERRORS, not "no data".
 *
 * Pre-fix all three dashboard charts destructured only
 * `{ data, isLoading }`: a failed query fell into the empty-state copy
 * ("Keine Daten in diesem Zeitraum" / "Keine Daten verfügbar") — and
 * the mood chart unmounted its card entirely. The fix surfaces
 * `isError` as a `<ChartErrorState>` card with a retry affordance in
 * each chart, keeping the card chrome mounted so the dashboard
 * composition stays intact.
 */

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: null,
    isLoading: false,
  }),
}));

function mockQueryError() {
  vi.doMock("@tanstack/react-query", () => ({
    useQuery: () => ({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: () => Promise.resolve(),
    }),
    useQueryClient: () => ({
      cancelQueries: () => Promise.resolve(),
      getQueryData: () => undefined,
      setQueryData: () => undefined,
      invalidateQueries: () => Promise.resolve(),
    }),
    useMutation: () => ({ mutate: () => undefined, isPending: false }),
  }));
}

describe("chart isError rendering — error state, not empty state", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("<HealthChart> paints the error card with retry, keeps the card chrome", async () => {
    mockQueryError();

    const { I18nProvider } = await import("@/lib/i18n/context");
    const { HealthChart } = await import("../health-chart");

    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="de" initialMessages={deMessages}>
        <HealthChart types={["PULSE"]} title="Pulse" unit="bpm" />
      </I18nProvider>,
    );

    expect(html).toContain('data-slot="chart-error-state"');
    expect(html).toContain("Daten konnten nicht geladen werden");
    expect(html).toContain("Erneut versuchen");
    // Card chrome must stay mounted.
    expect(html).toContain("Pulse");
    // The empty-state copy must NOT paint — an outage is not "no data".
    expect(html).not.toContain("Keine Daten in diesem Zeitraum");

    vi.doUnmock("@tanstack/react-query");
  });

  it("<MoodChart> keeps the card mounted and paints the error card", async () => {
    mockQueryError();

    const { I18nProvider } = await import("@/lib/i18n/context");
    const { MoodChart } = await import("../mood-chart");

    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="de" initialMessages={deMessages}>
        <MoodChart />
      </I18nProvider>,
    );

    // Pre-fix the component returned null here — html was empty.
    expect(html).toContain('data-slot="chart-error-state"');
    expect(html).toContain("Daten konnten nicht geladen werden");
    expect(html).toContain("Erneut versuchen");

    vi.doUnmock("@tanstack/react-query");
  });

  it("<MedicationComplianceChart> paints the error card, not the no-data hint", async () => {
    mockQueryError();

    const { I18nProvider } = await import("@/lib/i18n/context");
    const { MedicationComplianceChart } = await import(
      "../medication-compliance-chart"
    );

    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="de" initialMessages={deMessages}>
        <MedicationComplianceChart />
      </I18nProvider>,
    );

    expect(html).toContain('data-slot="chart-error-state"');
    expect(html).toContain("Daten konnten nicht geladen werden");
    expect(html).toContain("Erneut versuchen");
    expect(html).not.toContain("Keine Daten im gewählten Zeitraum");

    vi.doUnmock("@tanstack/react-query");
  });
});
