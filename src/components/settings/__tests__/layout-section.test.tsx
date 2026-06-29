/**
 * v1.25.7 — the "Appearance" home (slug stays `layout`).
 *
 * The hub stopped being a link list: it now composes the dashboard, insights,
 * and every tracking module's settings inline as stacked, anchored sections.
 * Each module section keeps its module-gate (fail-open `!== false`), so a
 * disabled module's section does not render. These tests pin the composition
 * contract — anchors, headings, and gating — and mock the child section
 * components (each has its own dedicated test) so the render stays a pure
 * composition smoke.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Mutable modules ref so each render can pick a different gate map.
const authRef: { modules?: Record<string, boolean> } = {};
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", username: "t", role: "USER", modules: authRef.modules },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

// Each composed surface has its own test; stub them at the import boundary so
// this test exercises only the LayoutSection composition (anchors + gating).
vi.mock("@/components/settings/dashboard-section", () => ({
  DashboardSection: () => <div data-testid="body-dashboard" />,
}));
vi.mock("@/components/settings/insights-section", () => ({
  InsightsSection: () => <div data-testid="body-insights" />,
}));
vi.mock("@/components/settings/medications-section", () => ({
  MedicationsSection: () => <div data-testid="body-medications" />,
}));
vi.mock("@/components/settings/mood-section", () => ({
  MoodSection: () => <div data-testid="body-mood" />,
}));
vi.mock("@/components/settings/labs-section", () => ({
  LabsSection: () => <div data-testid="body-labs" />,
}));
vi.mock("@/components/settings/illness-section", () => ({
  IllnessSection: () => <div data-testid="body-illness" />,
}));
vi.mock("@/components/settings/vorsorge-section", () => ({
  VorsorgeSection: () => <div data-testid="body-vorsorge" />,
}));

import { I18nProvider } from "@/lib/i18n/context";
import { LayoutSection } from "../layout-section";

function render(modules?: Record<string, boolean>, locale: "en" | "de" = "en") {
  authRef.modules = modules;
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <LayoutSection />
    </I18nProvider>,
  );
}

describe("<LayoutSection>", () => {
  it("stacks every surface inline with a stable anchor id (fail-open default)", () => {
    const html = render(undefined);
    for (const id of [
      "dashboard",
      "insights",
      "medications",
      "mood",
      "labs",
      "illness",
      "vorsorge",
    ]) {
      expect(html).toContain(`id="${id}"`);
      expect(html).toContain(`data-testid="body-${id}"`);
    }
    // It is no longer a link hub — no `/settings/*` cards.
    expect(html).not.toContain('href="/settings/');
  });

  it("hides a module's section when that module is disabled", () => {
    const html = render({ medications: false, labs: false });
    expect(html).not.toContain('data-testid="body-medications"');
    expect(html).not.toContain('id="medications"');
    expect(html).not.toContain('data-testid="body-labs"');
    expect(html).not.toContain('id="labs"');
    // Other modules unaffected; Vorsorge is never gated.
    expect(html).toContain('data-testid="body-mood"');
    expect(html).toContain('data-testid="body-vorsorge"');
  });

  it("always renders dashboard, insights, and vorsorge (no module gate)", () => {
    const html = render({
      medications: false,
      mood: false,
      labs: false,
      illness: false,
    });
    expect(html).toContain('data-testid="body-dashboard"');
    expect(html).toContain('data-testid="body-insights"');
    expect(html).toContain('data-testid="body-vorsorge"');
    expect(html).not.toContain('data-testid="body-mood"');
  });

  it("resolves its section headings via i18n (no raw keys leak)", () => {
    const html = render();
    expect(html).toContain("Medications");
    expect(html).toContain("Labs");
    expect(html).not.toContain("settings.sections.layout.");
  });

  it("resolves the headings in German too", () => {
    const html = render(undefined, "de");
    expect(html).toContain("Medikamente");
    expect(html).toContain("Labor");
    expect(html).not.toContain("settings.sections.layout.");
  });
});
