import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * v1.4.15 phase-C5 — `/admin/backups` empty state.
 *
 * The previous build rendered a single-line `<p>No backups recorded
 * yet.</p>` inside the card. Brand-new admins didn't realise the "Run
 * backup now" CTA in the header was the way to create one, so the page
 * felt inert. The new EmptyState primitive duplicates the header CTA
 * inside the card so the action is right next to the explanation.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/admin/backups",
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: { rows: [], retentionDays: 30 },
    isLoading: false,
    isError: false,
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
    variables: undefined,
  }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", username: "testuser", role: "ADMIN" },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { BackupsSection } from "../backups-section";

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <BackupsSection />
    </I18nProvider>,
  );
}

describe("BackupsSection — empty state", () => {
  it("renders the EmptyState primitive when no backups exist", () => {
    const html = render();
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("border-dashed");
  });

  it("includes the localized title and description", () => {
    const html = render();
    expect(html).toContain("No backups yet");
    expect(html).toContain("Backups run automatically every Sunday at 03:00");
  });

  it("exposes the Backup-now CTA inside the empty card", () => {
    const html = render();
    // The header's CTA is also "Backup now"; the empty-state CTA must
    // appear AT LEAST TWICE — once in the header, once inside the
    // empty card. If the empty card forgets the action we'd see only
    // one occurrence.
    const matches = (html.match(/Backup now/g) ?? []).length;
    expect(matches).toBeGreaterThanOrEqual(2);
  });
});
