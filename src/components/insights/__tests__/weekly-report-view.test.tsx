import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/context";
import { WeeklyReportPresentation } from "../weekly-report-view";
import type { WeeklyReport } from "@/lib/ai/schema";

/**
 * v1.4.20 phase B4 — pure-presentational layer of the printable
 * weekly report. The wrapper component (`WeeklyReportView`) consumes
 * `useInsightsAdvisorQuery` + `useAuth`; the tests target the
 * presentation slot directly so SSR rendering doesn't need a TanStack
 * Query setup.
 */

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

const sampleReport: WeeklyReport = {
  weekISO: "2026-W19",
  summary:
    "Strong week — BP held under 130/85 on 9 of 10 readings and weight is down 0.6 kg.",
  goingWell: [
    "BP under 130/85 on 9 of 10 readings.",
    "Compliance 94 % over the past 7 days.",
  ],
  worthWatching: ["Monday-morning systolic +6 mmHg over 6 weeks."],
  tips: ["Consider a brief walk after dinner on Mondays."],
  dataQualityNotes: "Only 5 BP readings this week — n is borderline.",
};

describe("<WeeklyReportPresentation>", () => {
  it("renders the article wrapper with the locale on lang", () => {
    const html = render(
      <WeeklyReportPresentation weekISO="2026-W19" report={sampleReport} />,
    );
    expect(html).toMatch(/data-slot="weekly-report"/);
    expect(html).toMatch(/lang="en"/);
  });

  it("renders the eyebrow chip + title with the week", () => {
    const html = render(
      <WeeklyReportPresentation weekISO="2026-W19" report={sampleReport} />,
    );
    expect(html).toMatch(/data-slot="weekly-report-eyebrow"/);
    expect(html).toContain("Weekly report");
    expect(html).toMatch(/data-slot="weekly-report-title"/);
    expect(html).toContain("Your week — 2026-W19");
  });

  it("renders the date range derived from the ISO week", () => {
    const html = render(
      <WeeklyReportPresentation weekISO="2026-W19" report={sampleReport} />,
    );
    expect(html).toMatch(/data-slot="weekly-report-daterange"/);
    // Range is May 04..May 10, 2026; locale-aware formatting picks dd/mm/yyyy
    // for English. Anchor on the year so the assertion stays stable.
    expect(html).toContain("2026");
  });

  it("renders all five sections when the report is fully populated", () => {
    const html = render(
      <WeeklyReportPresentation weekISO="2026-W19" report={sampleReport} />,
    );
    expect(html).toMatch(/data-slot="weekly-report-summary"/);
    expect(html).toMatch(/data-slot="weekly-report-going-well"/);
    expect(html).toMatch(/data-slot="weekly-report-worth-watching"/);
    expect(html).toMatch(/data-slot="weekly-report-tips"/);
    expect(html).toMatch(/data-slot="weekly-report-data-quality"/);
  });

  it("hides the going-well section when the array is empty", () => {
    const html = render(
      <WeeklyReportPresentation
        weekISO="2026-W19"
        report={{ ...sampleReport, goingWell: [] }}
      />,
    );
    expect(html).not.toContain('data-slot="weekly-report-going-well"');
  });

  it("hides the data-quality section when no notes were emitted", () => {
    const html = render(
      <WeeklyReportPresentation
        weekISO="2026-W19"
        report={{ ...sampleReport, dataQualityNotes: undefined }}
      />,
    );
    expect(html).not.toContain('data-slot="weekly-report-data-quality"');
  });

  it("renders the empty-state with a Generate CTA when report is null", () => {
    const html = render(
      <WeeklyReportPresentation weekISO="2026-W19" report={null} />,
    );
    expect(html).toMatch(/data-slot="weekly-report-empty"/);
    expect(html).toContain("No report for this week yet");
    expect(html).toContain("Open Insights");
  });

  it("renders the toolbar with back link + print button", () => {
    const html = render(
      <WeeklyReportPresentation weekISO="2026-W19" report={sampleReport} />,
    );
    expect(html).toMatch(/data-slot="weekly-report-toolbar"/);
    expect(html).toContain("Back to insights");
    expect(html).toMatch(/data-slot="weekly-report-print"/);
    expect(html).toContain("Print / Export PDF");
  });

  it("includes the not-medical-advice footer when report is present", () => {
    const html = render(
      <WeeklyReportPresentation weekISO="2026-W19" report={sampleReport} />,
    );
    expect(html).toMatch(/data-slot="weekly-report-footer"/);
    expect(html).toContain("Not medical advice");
  });

  it("renders the German locale", () => {
    const html = render(
      <WeeklyReportPresentation weekISO="2026-W19" report={sampleReport} />,
      "de",
    );
    expect(html).toMatch(/lang="de"/);
    expect(html).toContain("Wochenbericht");
    expect(html).toContain("Was gut läuft");
    expect(html).toContain("Was Beachtung verdient");
  });

  it("applies print-friendly Tailwind variants on the article wrapper", () => {
    const html = render(
      <WeeklyReportPresentation weekISO="2026-W19" report={sampleReport} />,
    );
    expect(html).toContain("print:max-w-none");
    expect(html).toContain("print:px-0");
  });

  it("hides the toolbar in print output via print:hidden", () => {
    const html = render(
      <WeeklyReportPresentation weekISO="2026-W19" report={sampleReport} />,
    );
    const toolbarMatch = html.match(
      /<header[^>]*data-slot="weekly-report-toolbar"[^>]*>/,
    );
    expect(toolbarMatch).not.toBeNull();
    expect(toolbarMatch?.[0]).toContain("print:hidden");
  });
});
