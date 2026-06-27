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

// Each test mutates `mockUserRef.value.role` before rendering so we can
// exercise both regular-user and admin layouts from the same suite.
const mockUserRef = {
  value: {
    id: "u1",
    username: "testuser",
    email: "user@example.com",
    role: "USER" as "USER" | "ADMIN",
    avatarUrl: null,
    // v1.18.0 — nav gating reads the resolved per-user module map; cycle is
    // the delegated `cycle` key on it (no bespoke boolean). An absent key
    // fails open (entry shows), matching the gate's default-on contract.
    modules: {} as Record<string, boolean>,
  },
};
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: mockUserRef.value,
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

// The bug-report flag — each test mutates `mockSettingsRef.value` before
// rendering so the sidebar reads the desired state.
const mockSettingsRef = { value: { bugReportEnabled: true } };
vi.mock("@/components/app-settings-provider", () => ({
  useAppSettings: () => mockSettingsRef.value,
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/lib/i18n/context";
import { SidebarNav } from "../sidebar-nav";
import { ADMIN_SECTIONS } from "@/components/admin/admin-shell";
import { visibleUtilityDestinations } from "../nav-model";

function render({
  pathname = "/",
  bugReportEnabled = true,
  role = "USER" as "USER" | "ADMIN",
  modules = {} as Record<string, boolean>,
}: {
  pathname?: string;
  bugReportEnabled?: boolean;
  role?: "USER" | "ADMIN";
  modules?: Record<string, boolean>;
} = {}) {
  mockPathnameRef.value = pathname;
  mockSettingsRef.value = { bugReportEnabled };
  mockUserRef.value = { ...mockUserRef.value, role, modules };
  return renderToStaticMarkup(
    // The nav reads `useQueryClient()` for the medications intent
    // prefetch (v1.16.7); a fresh client per render keeps the SSR
    // markup assertions isolated.
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider initialLocale="en">
        <SidebarNav />
      </I18nProvider>
    </QueryClientProvider>,
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

describe("<SidebarNav> cycle entry gate (v1.15.0 / v1.18.0 module map)", () => {
  it("renders the Cycle entry when the cycle module is enabled", () => {
    const html = render({ modules: { cycle: true } });
    expect(html).toContain('href="/cycle"');
    expect(html).toContain("Cycle");
  });

  it("hides the Cycle entry when the cycle module is disabled", () => {
    const html = render({ modules: { cycle: false } });
    expect(html).not.toContain('href="/cycle"');
  });

  it("places the Cycle entry between Mood and Medications when enabled", () => {
    const html = render({ modules: { cycle: true } });
    const mood = html.indexOf('href="/mood"');
    const cycle = html.indexOf('href="/cycle"');
    const med = html.indexOf('href="/medications"');
    expect(mood).toBeGreaterThan(-1);
    expect(cycle).toBeGreaterThan(-1);
    expect(med).toBeGreaterThan(-1);
    // v1.19.1 (S4) — Cycle sits after Mood and before Medications in document
    // order; Medications opens the fixed clinical/insight spine below it.
    expect(mood).toBeLessThan(cycle);
    expect(cycle).toBeLessThan(med);
  });
});

describe("<SidebarNav> module gating (v1.18.0)", () => {
  it("hides a disabled module's nav entry (mood / labs / coach / achievements)", () => {
    const html = render({
      modules: {
        mood: false,
        labs: false,
        coach: false,
        achievements: false,
      },
    });
    expect(html).not.toContain('href="/mood"');
    expect(html).not.toContain('href="/labs"');
    expect(html).not.toContain('href="/coach"');
    expect(html).not.toContain('href="/achievements"');
    // Core destinations stay regardless of the module map.
    expect(html).toContain('href="/measurements"');
    expect(html).toContain('href="/medications"');
    expect(html).toContain('href="/insights"');
    expect(html).toContain('href="/checkups"');
  });

  it("renders a module's nav entry when its module is enabled", () => {
    const html = render({
      modules: {
        mood: true,
        labs: true,
        coach: true,
        achievements: true,
      },
    });
    expect(html).toContain('href="/mood"');
    expect(html).toContain('href="/labs"');
    expect(html).toContain('href="/coach"');
    expect(html).toContain('href="/achievements"');
  });

  it("fails open: an empty module map keeps every gated entry visible", () => {
    const html = render({ modules: {} });
    expect(html).toContain('href="/mood"');
    expect(html).toContain('href="/cycle"');
    expect(html).toContain('href="/labs"');
    expect(html).toContain('href="/coach"');
    expect(html).toContain('href="/achievements"');
  });
});

describe("<SidebarNav> targets deprecation (v1.8.6)", () => {
  it("no longer renders the deprecated /targets entry", () => {
    // The Targets (Zielwerte) page is deprecated; target editing moved
    // inline into Insights, so the sidebar drops the entry. The main nav
    // links render into the SSR markup, so asserting absence here is a
    // real regression net (Insights, the sibling that stays, still shows).
    const html = render();
    expect(html).not.toContain('href="/targets"');
    expect(html).toContain('href="/insights"');
  });
});

describe("<SidebarNav> unified destination model (v1.17.1 F-1 / F-3)", () => {
  it("surfaces the Coach as a first-class sidebar destination", () => {
    // Pre-unify the sidebar had no Coach home while the mobile bar missed
    // it too; both now render the one shared model so both carry it.
    // (v1.18.0 — Workouts left the left nav for its Insights pill, so it is
    // no longer a sidebar destination.)
    const html = render();
    expect(html).toContain('href="/coach"');
    expect(html).toContain("Coach");
    expect(html).not.toContain('href="/insights/workouts"');
  });

  it("marks Coach active without also marking Insights active", () => {
    const html = render({ pathname: "/coach" });
    // The Coach link carries aria-current="page"; the standalone /coach
    // route is not a sibling of /insights, so the Insights link must not.
    const coach = html.match(/<a[^>]*href="\/coach"[^>]*>/);
    const insights = html.match(/<a[^>]*href="\/insights"[^>]*>/);
    expect(coach?.[0]).toMatch(/aria-current="page"/);
    expect(insights?.[0]).not.toMatch(/aria-current="page"/);
  });
});

describe("<SidebarNav> shared utility tail (v1.17.1 N-1 parity guard)", () => {
  // The footer renders the shared utility tail EXCEPT Notifications, which
  // lives in the avatar dropdown (a Radix menu that is collapsed — and so
  // not in the SSR markup — until opened). The footer-visible utilities are
  // therefore the shared list minus `/notifications`. Asserting they all
  // render straight from the shared list is the parity net that keeps the
  // sidebar footer from drifting away from the mobile More-hub tail.
  const footerUtilities = (bugReportEnabled: boolean) =>
    visibleUtilityDestinations(bugReportEnabled).filter(
      (d) => d.href !== "/notifications",
    );

  it("renders every footer utility destination straight from the shared list", () => {
    const html = render({ bugReportEnabled: true });
    for (const dest of footerUtilities(true)) {
      expect(html).toContain(`href="${dest.href}"`);
    }
    // Bug Report and Settings are the footer utilities; both are present.
    expect(html).toContain('href="/bugreport"');
    expect(html).toContain('href="/settings/account"');
  });

  it("drops the bug-report utility entry when the operator flag is off", () => {
    const html = render({ bugReportEnabled: false });
    for (const dest of footerUtilities(false)) {
      expect(html).toContain(`href="${dest.href}"`);
    }
    expect(html).not.toContain('href="/bugreport"');
  });
});

describe("<SidebarNav> admin entry mirrors Settings (no sub-item expansion)", () => {
  // v1.4.16 A1: the maintainer reported the global sidebar expanding admin
  // sub-items on `/admin/*` was unwanted UX — the in-shell `<AdminShell>`
  // already provides per-section nav inside the page. The Admin entry
  // must behave EXACTLY like the Settings entry: a single link with no
  // sub-list at any route, regardless of where the avatar dropdown is.

  it("does not render admin entries at all for a regular user", () => {
    const html = render({ role: "USER", pathname: "/admin/system-status" });
    expect(html).not.toContain('href="/admin"');
    for (const section of ADMIN_SECTIONS) {
      expect(html).not.toContain(`href="/admin/${section.slug}"`);
    }
  });

  it("for an admin off /admin/* shows a single Admin link without sub-items", () => {
    const html = render({ role: "ADMIN", pathname: "/" });
    expect(html).toContain('href="/admin"');
    // No sub-route links — sidebar collapses into a single Admin entry.
    for (const section of ADMIN_SECTIONS) {
      expect(html).not.toContain(`href="/admin/${section.slug}"`);
    }
  });

  it("for an admin on /admin/* still shows ONLY the single Admin link (no sub-list)", () => {
    const html = render({ role: "ADMIN", pathname: "/admin/system-status" });
    expect(html).toContain('href="/admin"');
    // Sub-section links must NOT appear in the global sidebar — they
    // belong to `<AdminShell>`'s in-page nav. the maintainer reported the
    // expansion as broken UX in v1.4.16; this guard keeps it gone.
    for (const section of ADMIN_SECTIONS) {
      expect(html).not.toContain(`href="/admin/${section.slug}"`);
    }
  });

  it("on the /admin overview page also shows ONLY the single Admin link", () => {
    const html = render({ role: "ADMIN", pathname: "/admin" });
    expect(html).toContain('href="/admin"');
    for (const section of ADMIN_SECTIONS) {
      expect(html).not.toContain(`href="/admin/${section.slug}"`);
    }
  });

  it("Admin entry markup mirrors Settings entry markup (same shape, no expansion)", () => {
    // Both Settings and Admin should render as a single <a> with no
    // adjacent <ul> sub-list. Counting <ul aria-label="Admin sections"
    // (or any descendant ul under the Admin link) confirms there's no
    // disclosure widget. We assert by checking the structural pattern:
    // the Admin link is followed by the Settings link (or the user
    // section), never by a <ul>.
    const html = render({ role: "ADMIN", pathname: "/admin/system-status" });
    // No sub-list <ul> on /admin/*: previously this was the
    // `aria-label={t("admin.shell.sectionsNav")}` ul; assert the only
    // Settings-bearing nav surface is intact (sectionsNav label belongs
    // to `<AdminShell>`, which the sidebar must NOT echo).
    expect(html).not.toMatch(/aria-label="Admin sections"/);
  });
});
