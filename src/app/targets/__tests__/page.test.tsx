import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

/**
 * v1.8.6 — `/targets` deprecation banner.
 *
 * The Targets (Zielwerte) page is deprecated: target-range editing moved
 * inline into the Insights category pages. The page stays routable but
 * carries a top banner telling the user where editing lives now and that
 * the page will be removed in a future release. This SSR test pins the
 * banner copy + structure.
 *
 * The page leans on `useAuth`, two `useQuery` reads, `useFeatureFlags`
 * and `useCoachHandoff`; all are stubbed so the render reaches the
 * banner without standing up an App-Router runtime or a QueryClient.
 */

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: { id: "u1", disableCoach: false },
  }),
}));

// The page issues two `useQuery` reads (targets payload + provider
// chain). Drive both off the same stub: the first call resolves the
// targets payload, the rest return a null provider chain.
let queryCall = 0;
const TARGETS_PAYLOAD = {
  targets: [],
  bpDiastolic: { current: null, average30: null, range: null },
  profile: { heightCm: 175, age: 40, gender: "male", glucoseUnit: "mg/dL" },
};
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => {
    queryCall += 1;
    if (queryCall === 1) {
      return { data: TARGETS_PAYLOAD, isLoading: false };
    }
    return { data: null, isLoading: false };
  },
}));

// Turn Coach off so the page never mounts the SSE drawer machinery.
vi.mock("@/hooks/use-feature-flags", () => ({
  useFeatureFlags: () => ({
    enabled: false,
    coach: false,
    briefing: false,
    insightStatus: false,
    correlations: false,
    healthScoreExplainer: false,
  }),
}));

vi.mock("@/hooks/use-coach-handoff", () => ({
  useCoachHandoff: () => ({
    coachOpen: false,
    setCoachOpen: vi.fn(),
    coachPrefill: null,
    coachScope: null,
    askCoach: vi.fn(),
  }),
}));

const { default: TargetsPage } = await import("../page");

function render(locale: "en" | "de" = "en") {
  queryCall = 0;
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <TargetsPage />
    </I18nProvider>,
  );
}

describe("<TargetsPage> deprecation banner", () => {
  it("renders the deprecation banner with title + body", () => {
    const html = render();
    expect(html).toContain('data-slot="targets-deprecation"');
    expect(html).toContain("This page is being retired");
    expect(html).toContain("Insights");
    // Reuses the warning-card visual pattern.
    expect(html).toContain("border-warning");
  });

  it("localises the banner copy", () => {
    const html = render("de");
    expect(html).toContain("Diese Seite wird eingestellt");
  });
});
