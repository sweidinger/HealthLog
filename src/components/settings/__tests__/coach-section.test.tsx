/**
 * v1.18.0 (S5) — Settings → Coach section.
 *
 * The Coach preference cards (disable toggle, preferences, memory) moved
 * out of the AI / Assistant section into their own dedicated, module-gated
 * entry. SSR-only smoke test — interactive contracts live in the cards'
 * own suites (`disable-coach-card.test.tsx`, `coach-memory-section.test.tsx`).
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/settings/coach",
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: null, isLoading: false, refetch: vi.fn() }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

const authState: { disableCoach: boolean } = { disableCoach: false };
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", role: "USER", disableCoach: authState.disableCoach },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { CoachSection } from "../coach-section";

function render(locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <CoachSection />
    </I18nProvider>,
  );
}

describe("<CoachSection> — SSR smoke", () => {
  it("renders the section scaffold + the Activate-Coach toggle card", () => {
    authState.disableCoach = false;
    const html = render();
    expect(html).toContain('id="settings-section-coach-title"');
    expect(html).toContain('data-testid="settings-disable-coach-card"');
    expect(html).toContain('data-testid="settings-disable-coach-switch"');
    // v1.18.1 (D7) — polarity flipped to activate/default-on.
    expect(html).toContain("Activate Coach");
    expect(html).toContain("Show the Coach button and drawer. On by default");
    // Raw key never leaks past i18n.
    expect(html).not.toContain("settings.sections.coach.");
    expect(html).not.toContain("settings.coach.activate.");
  });

  it("renders the German Activate-Coach copy", () => {
    authState.disableCoach = false;
    const html = render("de");
    expect(html).toContain("Coach aktivieren");
    expect(html).toContain("Standardmäßig an");
    expect(html).not.toContain("settings.sections.coach.");
    expect(html).not.toContain("settings.coach.activate.");
  });
});
