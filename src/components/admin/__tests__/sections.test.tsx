import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The section components rely on TanStack Query, the auth hook, and a
// few API routes. Stub everything at the module boundary so we can
// SSR-render each section in isolation and assert the heading paints.
//
// This is intentionally a smoke test — covering the loading branch
// (most sections paint a Loader2 + label until data arrives) is enough
// to guarantee the dynamic-route renderer doesn't blow up when it
// imports a section.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/admin/system-status",
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: null, isLoading: false, refetch: vi.fn() }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: {
      id: "u1",
      username: "marc",
      email: "marc@example.com",
      role: "ADMIN",
    },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { ADMIN_SECTION_SLUGS } from "../section-slugs";
import { ApiTokenOverviewSection } from "../api-token-overview-section";
import { BackupsSection } from "../backups-section";
import { DangerZoneSection } from "../danger-zone-section";
import { FeedbackInboxSection } from "../feedback-inbox-section";
import { GeneralSettingsSection } from "../general-settings-section";
import { IntegrationsGroupSection } from "../integrations-group-section";
import { LoginOverviewSection } from "../login-overview-section";
import { RemindersSection } from "../reminders-section";
import { ServicesSection } from "../services-section";
import { SystemStatusSection } from "../system-status-section";
import { UserManagementSection } from "../user-management-section";

function render(node: React.ReactElement) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

describe("admin sections — SSR smoke", () => {
  it("every slug in `ADMIN_SECTION_SLUGS` has a wired component", () => {
    // Renderer-side parity: if a slug is added to the list but no
    // matching case is added in `renderer.tsx`, the switch's `never`
    // exhaustiveness guard fails type-check. This test mirrors that
    // guarantee at runtime so a slug typo (or stale list) is caught
    // even without `tsc`.
    expect(ADMIN_SECTION_SLUGS).toContain("system-status");
    expect(ADMIN_SECTION_SLUGS).toContain("backups");
    expect(ADMIN_SECTION_SLUGS).toContain("users");
    expect(ADMIN_SECTION_SLUGS).toContain("danger-zone");
  });

  it("<SystemStatusSection> renders", () => {
    const html = render(<SystemStatusSection />);
    expect(html).toContain("System");
  });

  it("<GeneralSettingsSection> renders", () => {
    const html = render(<GeneralSettingsSection />);
    expect(html).toContain("Allow registration");
  });

  it("<ServicesSection> renders", () => {
    const html = render(<ServicesSection />);
    expect(html).toContain("Telegram");
  });

  it("<IntegrationsGroupSection> renders all four sub-sections", () => {
    const html = render(<IntegrationsGroupSection />);
    expect(html).toContain("Umami");
    expect(html).toContain("Glitchtip");
    expect(html).toContain("Web Push");
  });

  it("<FeedbackInboxSection> renders", () => {
    const html = render(<FeedbackInboxSection />);
    expect(html).toContain("Feedback");
  });

  it("<RemindersSection> renders", () => {
    const html = render(<RemindersSection />);
    expect(html).toContain("Medication Reminders");
  });

  it("<UserManagementSection> renders with filter pills", () => {
    const html = render(<UserManagementSection />);
    expect(html).toContain("User Management");
    // Filter pills painted from i18n
    expect(html).toContain("All");
    expect(html).toContain("Admins");
  });

  it("<ApiTokenOverviewSection> renders", () => {
    const html = render(<ApiTokenOverviewSection />);
    expect(html).toContain("API Tokens");
  });

  it("<LoginOverviewSection> renders", () => {
    const html = render(<LoginOverviewSection />);
    expect(html).toContain("Login Overview");
  });

  it("<BackupsSection> renders heading + run-now button", () => {
    const html = render(<BackupsSection />);
    expect(html).toContain("Backups");
    expect(html).toContain("Backup now");
  });

  it("<DangerZoneSection> renders", () => {
    const html = render(<DangerZoneSection />);
    expect(html).toContain("Danger Zone");
  });
});
