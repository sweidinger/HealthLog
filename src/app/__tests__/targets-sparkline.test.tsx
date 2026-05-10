import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * v1.4.22 C1 — `/targets` (Zielwerte) page upgrade.
 *
 * Each target card grew a 30-day sparkline + a "Δ vs. last month"
 * caption so the page reads as a living health log instead of a
 * static reference card. The API ships `points30d: number[]` and
 * `deltaVsLastMonth: number` per target; the page renders a tiny
 * dependency-free SVG path plus the localised delta caption.
 *
 * Cards without enough data (fewer than 3 points in either window)
 * keep their previous v1.4.19 layout — sparkline and delta caption
 * stay absent so cold-start accounts don't see a misleading flat
 * trace or a "± 0" comparison that's really "no comparison".
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/targets",
}));

const sampleData = {
  targets: [
    {
      type: "WEIGHT",
      label: "Weight",
      current: 88.2,
      average30: 88.6,
      trend: "stable",
      unit: "kg",
      range: { min: 60, max: 80 },
      classification: { category: "Normal", color: "#50fa7b" },
      source: "WHO BMI",
      points30d: [89.0, 88.8, 88.6, 88.4, 88.2],
      deltaVsLastMonth: -2.3,
    },
    {
      type: "PULSE",
      label: "Resting pulse",
      current: 72,
      average30: 72,
      trend: "stable",
      unit: "bpm",
      range: { min: 60, max: 100 },
      classification: { category: "On target", color: "#50fa7b" },
      source: "AHA",
      // No sparkline yet — cold-start account with <3 readings.
      points30d: null,
      deltaVsLastMonth: null,
    },
  ],
  bpDiastolic: { current: null, average30: null, range: null },
  profile: { heightCm: 180, age: 35, gender: "MALE", glucoseUnit: null },
};

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: sampleData,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: {
      id: "u1",
      username: "tester",
      email: "tester@example.com",
      role: "USER",
    },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import TargetsPage from "../targets/page";

function render(locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <TargetsPage />
    </I18nProvider>,
  );
}

describe("/targets page — sparkline + delta", () => {
  it("renders a sparkline SVG for cards with points30d", () => {
    const html = render();
    // The sparkline carries a stable data-slot the visual test pins.
    expect(html).toContain('data-slot="target-sparkline"');
    // Path with the dracula-purple token, not a hardcoded hex.
    expect(html).toContain("var(--dracula-purple)");
  });

  it("renders the Δ-vs-last-month caption with the signed delta", () => {
    const html = render();
    expect(html).toContain('data-slot="target-delta"');
    // Weight: −2.3 kg vs. last month
    expect(html).toMatch(/−2\.3\s*kg/);
    expect(html).toContain("vs. last month");
  });

  it("uses German vs.-Vormonat caption when the locale is `de`", () => {
    const html = render("de");
    expect(html).toContain("vs. Vormonat");
  });

  it("skips both sparkline and delta when the target has no points", () => {
    const html = render();
    // PULSE card has no points30d / no deltaVsLastMonth — only ONE
    // `target-sparkline` slot should be present (from the WEIGHT card).
    const sparklineMatches = html.match(/data-slot="target-sparkline"/g) ?? [];
    expect(sparklineMatches.length).toBe(1);
    const deltaMatches = html.match(/data-slot="target-delta"/g) ?? [];
    expect(deltaMatches.length).toBe(1);
  });
});
