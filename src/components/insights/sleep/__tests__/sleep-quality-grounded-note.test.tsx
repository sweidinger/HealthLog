import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { SleepQualityGroundedNote } from "../sleep-quality-grounded-note";
import type { DataSummary } from "@/lib/analytics/trends";

/**
 * v1.18.6 — the grounded sleep-quality note that fills the assessment slot
 * when no AI narrative is available. Pins that it builds substantive copy from
 * the user's own averages and that it self-suppresses when the AI is present.
 */
function summary(avg30: number): DataSummary {
  return {
    count: 30,
    latest: avg30,
    avg7: avg30,
    avg30,
  } as unknown as DataSummary;
}

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("<SleepQualityGroundedNote>", () => {
  const summaries = {
    SLEEP_SCORE: summary(82),
    SLEEP_EFFICIENCY: summary(88),
  };

  it("renders a substantive, grounded assessment when the AI is absent", () => {
    const html = render(
      <SleepQualityGroundedNote
        summaries={summaries}
        showWhenAiAbsent={true}
      />,
    );
    expect(html).toContain('data-slot="sleep-quality-grounded-note"');
    // The headline score (82 → fair on the 90/85/70 split) leads the read.
    expect(html).toContain("overall sleep score");
    expect(html).toContain("fair");
    expect(html).toContain("82");
  });

  it("renders nothing when the AI assessment is present", () => {
    const html = render(
      <SleepQualityGroundedNote
        summaries={summaries}
        showWhenAiAbsent={false}
      />,
    );
    expect(html).toBe("");
  });

  it("renders nothing when no quality metric is gradable", () => {
    const html = render(
      <SleepQualityGroundedNote
        summaries={{ SLEEP_NEED: summary(480) }}
        showWhenAiAbsent={true}
      />,
    );
    expect(html).toBe("");
  });
});
