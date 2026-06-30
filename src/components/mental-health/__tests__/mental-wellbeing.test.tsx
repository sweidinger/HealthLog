import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import en from "../../../../messages/en.json";

/**
 * Mental-wellbeing surface redesign (v1.25.3). The SSR-only convention
 * (`renderToStaticMarkup`, `environment: "node"`, no `@testing-library/react`)
 * means clicks can't be driven here — the wizard's advance/back grammar is
 * pinned in `check-in-nav.test.ts`. These tests pin the SSR-observable
 * contracts: the disclaimer renders ONLY on the landing (never while testing),
 * a positive item-9 surfaces the crisis card, and the history paints its chart
 * shell + dated list with severity + "support shown" badges.
 */

vi.mock("@/lib/api/api-fetch", () => ({
  apiGet: () => new Promise(() => {}),
  apiPost: () => new Promise(() => {}),
}));

import { MentalWellbeing } from "../mental-wellbeing";
import { CheckInWizard } from "../check-in-wizard";
import { AssessmentResult } from "../assessment-result";
import { AssessmentHistory } from "../assessment-history";
import { InstrumentCard } from "../instrument-card";
import type { AssessmentRow, CreateResponse } from "../types";

const mh = en.mentalHealth;

function withProviders(node: React.ReactNode): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en">{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

describe("landing chrome (v1.25.5 — disclaimer + heading removed)", () => {
  it("does NOT render the voluntary-self-test disclaimer anywhere", () => {
    // The disclaimer line + its (i) tooltip were removed from the landing;
    // the page leads with the description and the instrument cards.
    const html = withProviders(<MentalWellbeing />);
    expect(html).not.toContain('data-slot="mental-health-disclaimer"');
    expect(html).not.toContain("voluntary self-tests, not a diagnosis");
  });

  it("keeps the page title for screen readers but not as a visible heading", () => {
    const html = withProviders(<MentalWellbeing />);
    // The title survives as an sr-only h1 for the document outline.
    expect(html).toContain(mh.pageTitle);
    expect(html).toContain("sr-only");
    // …and the lead description still introduces the screeners.
    expect(html).toContain(mh.pageDescription);
  });

  it("does NOT render any disclaimer inside the check-in wizard", () => {
    const html = withProviders(
      <CheckInWizard
        instrument="PHQ9"
        onSubmit={() => {}}
        onBack={() => {}}
        isPending={false}
        isError={false}
      />,
    );
    expect(html).not.toContain('data-slot="mental-health-disclaimer"');
    // …but the standardized instrument explanation IS shown.
    expect(html).toContain(mh.instrumentDescription.phq9);
  });
});

describe("check-in wizard scaffolding", () => {
  const html = withProviders(
    <CheckInWizard
      instrument="PHQ9"
      onSubmit={() => {}}
      onBack={() => {}}
      isPending={false}
      isError={false}
    />,
  );

  it("reuses the medication wizard stepper", () => {
    expect(html).toContain('data-slot="wizard-stepper"');
  });

  it("opens on the first question with the Back/Next footer", () => {
    expect(html).toContain(mh.items.phq9["1"]);
    expect(html).toContain('data-slot="check-in-back"');
    expect(html).toContain('data-slot="check-in-next"');
    // Back is disabled on the first step.
    expect(html).toMatch(
      /data-slot="check-in-back"[^>]*disabled|disabled[^>]*data-slot="check-in-back"/,
    );
  });
});

describe("item-9 crisis surfacing on the result", () => {
  function result(crisis: CreateResponse["crisis"]): CreateResponse {
    return {
      assessment: {
        id: "a1",
        instrument: "PHQ9",
        locale: "en",
        totalScore: 18,
        severityBand: "modSevere",
        item9Flagged: crisis !== null,
        crisisShownAt: crisis !== null ? "2026-06-20T00:00:00.000Z" : null,
        takenAt: "2026-06-20T00:00:00.000Z",
      },
      actionThreshold: 10,
      crisis,
    };
  }

  it("renders the crisis card when item 9 is flagged", () => {
    const html = withProviders(
      <AssessmentResult
        result={result({
          emergencyNumber: "112",
          resources: [{ id: "findahelpline", contacts: ["findahelpline.com"] }],
        })}
        onTakeAnother={() => {}}
        onBack={() => {}}
      />,
    );
    expect(html).toContain('data-slot="mental-health-crisis-card"');
    // crisis.title carries an apostrophe (escaped by SSR) — assert a slice.
    expect(html).toContain("have to face this alone");
  });

  it("omits the crisis card when item 9 is not flagged", () => {
    const html = withProviders(
      <AssessmentResult
        result={result(null)}
        onTakeAnother={() => {}}
        onBack={() => {}}
      />,
    );
    expect(html).not.toContain('data-slot="mental-health-crisis-card"');
    // The result still paints.
    expect(html).toContain(mh.result.title);
  });
});

describe("history rendering", () => {
  const rows: AssessmentRow[] = [
    {
      id: "h1",
      instrument: "PHQ9",
      locale: "en",
      totalScore: 16,
      severityBand: "modSevere",
      item9Flagged: true,
      crisisShownAt: "2026-06-20T00:00:00.000Z",
      takenAt: "2026-06-20T00:00:00.000Z",
    },
    {
      id: "h2",
      instrument: "PHQ9",
      locale: "en",
      totalScore: 4,
      severityBand: "minimal",
      item9Flagged: false,
      crisisShownAt: null,
      takenAt: "2026-05-20T00:00:00.000Z",
    },
  ];

  const html = withProviders(<AssessmentHistory rows={rows} />);

  it("paints the lazy chart shell + the dated list", () => {
    expect(html).toContain('data-slot="skeleton"');
    expect(html).toContain('data-slot="history-list"');
  });

  it("shows the PHQ-9 / GAD-7 toggle and a severity badge", () => {
    expect(html).toContain('role="tablist"');
    expect(html).toContain(mh.band.PHQ9.modSevere);
  });

  it("marks a flagged row with the discreet support marker", () => {
    expect(html).toContain('data-slot="history-flagged-marker"');
    expect(html).toContain(mh.history.flaggedBadge);
  });

  it("renders the empty state with no rows", () => {
    const empty = withProviders(<AssessmentHistory rows={[]} />);
    expect(empty).toContain(mh.history.empty);
    expect(empty).not.toContain('data-slot="history-list"');
  });
});

describe("instrument card → per-instrument trend (v1.25.12)", () => {
  it("exposes the card body as a detail target separate from Start", () => {
    const html = withProviders(
      <InstrumentCard
        instrument="PHQ9"
        last={undefined}
        onStart={() => {}}
        onOpenDetail={() => {}}
      />,
    );
    // The title + last-result block is a button that opens the Verlauf…
    expect(html).toContain('data-slot="instrument-card-open"');
    expect(html).toContain(mh.openDetail);
    // …and the Start action is still its own button.
    expect(html).toContain(mh.start);
  });

  it("pins the history to one instrument: no toggle, bare (no titled card)", () => {
    const rows: AssessmentRow[] = [
      {
        id: "p1",
        instrument: "PHQ9",
        locale: "en",
        totalScore: 8,
        severityBand: "mild",
        item9Flagged: false,
        crisisShownAt: null,
        takenAt: "2026-06-20T00:00:00.000Z",
      },
      {
        id: "g1",
        instrument: "GAD7",
        locale: "en",
        totalScore: 12,
        severityBand: "moderate",
        item9Flagged: false,
        crisisShownAt: null,
        takenAt: "2026-06-20T00:00:00.000Z",
      },
    ];
    const html = withProviders(
      <AssessmentHistory rows={rows} instrument="PHQ9" />,
    );
    // Pinned: the PHQ-9 / GAD-7 toggle + the titled landing card are gone…
    expect(html).toContain('data-pinned="PHQ9"');
    expect(html).not.toContain('role="tablist"');
    // …only the chosen instrument's row paints (its band), not the other's.
    expect(html).toContain(mh.band.PHQ9.mild);
    expect(html).not.toContain(mh.band.GAD7.moderate);
  });

  it("shows the per-instrument empty state when that instrument has no rows", () => {
    const onlyGad: AssessmentRow[] = [
      {
        id: "g2",
        instrument: "GAD7",
        locale: "en",
        totalScore: 5,
        severityBand: "mild",
        item9Flagged: false,
        crisisShownAt: null,
        takenAt: "2026-06-20T00:00:00.000Z",
      },
    ];
    const html = withProviders(
      <AssessmentHistory rows={onlyGad} instrument="PHQ9" />,
    );
    expect(html).toContain(mh.history.empty);
    expect(html).not.toContain('data-slot="history-list"');
  });
});
