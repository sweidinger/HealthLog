import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// `<SidebarNav>` reads the active route from `usePathname()`. Stub
// next/navigation so the SSR test render works without an App-Router
// runtime.
const mockPathnameRef = { value: "/" };
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathnameRef.value,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

// Auth + theme + logout — the user section is rendered inside the
// sidebar and otherwise pulls in TanStack Query + the auth endpoint.
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: {
      id: "u1",
      username: "marc",
      email: "marc@example.com",
      role: "USER",
      gravatarUrl: null,
    },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
  useLogout: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/components/providers", () => ({
  useTheme: () => ({
    theme: "system" as const,
    resolvedTheme: "dark" as const,
    setTheme: vi.fn(),
  }),
}));

// The flag-under-test. Each test mutates `mockSettingsRef.value` before
// rendering so the sidebar reads the desired state.
const mockSettingsRef = { value: { bugReportEnabled: true } };
vi.mock("@/components/app-settings-provider", () => ({
  useAppSettings: () => mockSettingsRef.value,
}));

import { I18nProvider } from "@/lib/i18n/context";
import { SidebarNav } from "../sidebar-nav";

function render({
  pathname = "/",
  bugReportEnabled = true,
}: { pathname?: string; bugReportEnabled?: boolean } = {}) {
  mockPathnameRef.value = pathname;
  mockSettingsRef.value = { bugReportEnabled };
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <SidebarNav />
    </I18nProvider>,
  );
}

describe("<SidebarNav> bug-report toggle", () => {
  it("renders the Bug Report entry when the admin flag is enabled", () => {
    const html = render({ bugReportEnabled: true });
    expect(html).toContain('href="/bugreport"');
    // i18n string for the entry — sanity check that the link is the actual
    // bug-report nav entry, not e.g. an error-page report-bug button.
    expect(html).toContain("Bug Report");
  });

  it("hides the Bug Report entry when the admin flag is disabled", () => {
    const html = render({ bugReportEnabled: false });
    expect(html).not.toContain('href="/bugreport"');
  });
});
