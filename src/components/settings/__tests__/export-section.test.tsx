/**
 * v1.4.16 Phase B7 — Settings → Export section.
 *
 * The acceptance criterion for the consolidated Export menu is "five cards":
 *   1. Doctor Report (PDF)
 *   2. Measurements CSV
 *   3. Medications CSV (with optional intake-history toggle)
 *   4. Mood CSV
 *   5. Full JSON Backup
 *
 * Each card must surface a title, a 1-line description, and a download/generate
 * button. SSR-only smoke test — interaction is exercised by the e2e suite.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/settings/export",
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: null, isLoading: false, refetch: vi.fn() }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", role: "USER" },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { ExportSection } from "../export-section";

function render(node: React.ReactElement, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("<ExportSection> — SSR smoke", () => {
  it("renders the section heading + description", () => {
    const html = render(<ExportSection />);
    expect(html).toContain("Export");
    // Raw key never leaks past i18n.
    expect(html).not.toContain("settings.sections.export.");
  });

  it("renders exactly five export cards", () => {
    const html = render(<ExportSection />);
    // Each card carries a stable data-testid so the e2e suite can target
    // them without relying on the localised label.
    const ids = [
      "export-card-doctor-report",
      "export-card-measurements-csv",
      "export-card-medications-csv",
      "export-card-mood-csv",
      "export-card-full-backup",
    ];
    for (const id of ids) {
      expect(html).toContain(`data-testid="${id}"`);
    }
  });

  it("renders the medications-CSV intake-history toggle", () => {
    const html = render(<ExportSection />);
    // The medications card has a checkbox/toggle for "include intake
    // history" so the user can pick a smaller export when they only
    // want the medication list.
    expect(html).toContain('data-testid="export-medications-include-intake"');
  });

  it("renders a download/generate button per card", () => {
    const html = render(<ExportSection />);
    // Buttons are typed `button` and decorated with a stable testid so a
    // single regex finds all five — the labels themselves are i18n'd.
    const buttonMatches = html.match(/data-testid="export-action-/g);
    expect(buttonMatches?.length ?? 0).toBe(5);
  });

  it("German locale renders the DE heading", () => {
    const html = render(<ExportSection />, "de");
    expect(html).toContain("Export");
    expect(html).not.toContain("settings.sections.export.");
  });
});
