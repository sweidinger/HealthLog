/**
 * Stage B — the daily guided check-in entry point.
 *
 * Under the house SSR-only convention (`environment: "node"`,
 * `renderToStaticMarkup`, no `@testing-library/react`) the sheet body only
 * mounts once opened, so what the static markup can pin is the load-bearing
 * contract of the closed state:
 *
 *   - a class WITH a drug profile (STIMULANT) renders the labelled CTA
 *     affordance, so the check-in is reachable from the Verlauf tab;
 *   - a class WITHOUT a profile renders nothing (the component bails on a null
 *     profile), so a plain medication never shows an empty interview;
 *   - the CTA carries the i18n label, not a raw key, proving the
 *     `medications.dailyCheckin.*` namespace resolves.
 *
 * The submit flow (side-effect rows + seeded symptom metrics) writes through
 * the existing APIs and is covered by the registry + profile taxonomy tests;
 * this file guards the mount contract only.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { DailyCheckin } from "@/components/medications/daily-checkin";

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Number.POSITIVE_INFINITY,
        refetchOnMount: false,
      },
    },
  });
}

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <QueryClientProvider client={makeClient()}>{node}</QueryClientProvider>
    </I18nProvider>,
  );
}

describe("<DailyCheckin> — mount contract", () => {
  it("renders the labelled CTA for a class that has a drug profile", () => {
    const html = render(
      <DailyCheckin medicationId="med-1" treatmentClass="STIMULANT" />,
    );
    expect(html).toContain('data-slot="daily-checkin-cta"');
    // Resolved label, not the raw namespace key.
    expect(html).not.toContain("medications.dailyCheckin.cta");
  });

  it("renders nothing for a class without a drug profile", () => {
    const html = render(
      <DailyCheckin medicationId="med-1" treatmentClass="GENERIC" />,
    );
    expect(html).toBe("");
  });

  it("keeps the sheet body out of the closed static markup", () => {
    const html = render(
      <DailyCheckin medicationId="med-1" treatmentClass="STIMULANT" />,
    );
    expect(html).not.toContain('data-slot="daily-checkin-side-effects"');
    expect(html).not.toContain('data-slot="daily-checkin-symptoms"');
  });
});
