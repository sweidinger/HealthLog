"use client";

import { Loader2 } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { AchievementUnlockNotifier } from "@/components/gamification/achievement-unlock-notifier";
import { MaintainershipBanner } from "@/components/i18n/maintainership-banner";
import { LayoutCoachFab } from "@/components/insights/layout-coach-fab";
import { LayoutCoachMount } from "@/components/insights/layout-coach-mount";
import { TourLauncher } from "@/components/onboarding/tour-launcher";
import { useAuth } from "@/hooks/use-auth";
import { clearOfflineCachesForSessionEnd } from "@/lib/pwa/query-persister";
import { useTranslations } from "@/lib/i18n/context";
import { CoachLaunchProvider } from "@/lib/insights/coach-launch-context";
import { BottomNav } from "./bottom-nav";
import { DemoBanner } from "./demo-banner";
import { OfflineBanner } from "./offline-banner";
import { SidebarNav } from "./sidebar-nav";
import { TopBar } from "./top-bar";

// v1.4.27 MB6 — `/about` joins the public-path list so the GeoLite2
// CC BY-SA 4.0 attribution stays reachable for unauthenticated
// visitors. The `/about` route is already registered in `proxy.ts`
// PUBLIC_PATHS; this constant gates the client-side auth shell, and
// both lists must agree or the route round-trips through the
// sign-in redirect.
const PUBLIC_PATHS = [
  "/auth/login",
  "/auth/register",
  "/privacy",
  "/about",
  // v1.11.0 — the public clinician view renders its own standalone chrome
  // (no nav / coach / auth gate). Listed here so the shell hands it through
  // bare; the route is also in `proxy.ts` PUBLIC_PATHS so it never round-trips
  // the sign-in redirect.
  "/c/",
];

export function AuthShell({
  children,
  demoMode = false,
}: {
  children: React.ReactNode;
  /**
   * True when the instance runs with `DEMO_MODE=true` (resolved by the
   * server-side root layout). Renders the persistent demo banner above
   * the app chrome so a visitor knows mutations won't persist.
   */
  demoMode?: boolean;
}) {
  const { user, isAuthenticated, isLoading } = useAuth();
  const { t } = useTranslations();
  const pathname = usePathname();
  const router = useRouter();

  const isPublicPage = PUBLIC_PATHS.some((p) => pathname.startsWith(p));
  // v1.4.26 — `/privacy` is a long-form legal page that brings its own
  // header + footer. Centering it inside the public-page wrapper would
  // squash a 3000-word policy into a "login card" layout, so we let it
  // render edge-to-edge while still resolving as a public page for the
  // auth gate above.
  // v1.4.27 MB6 — `/about` follows the same shape (own header, own
  // footer, full-width body), so it joins the standalone list.
  // v1.11.0 — the clinician view (`/c/*`) renders edge-to-edge with its own
  // standalone chrome and no app shell, like the legal pages.
  const isStandalonePublicPage =
    pathname.startsWith("/privacy") ||
    pathname.startsWith("/about") ||
    pathname.startsWith("/c/");
  const isAdminPage = pathname.startsWith("/admin");
  const isOnboardingPage = pathname === "/onboarding";
  const showUnlockNotifier = isAuthenticated && !isPublicPage && !!user?.id;

  // v1.9.0 — the document-level scrollbar-gutter (globals.css) is reserved
  // only for the body-scrolled shells (login / register / onboarding /
  // standalone legal pages). The authenticated branch is height-locked and
  // scrolls inside its own `<main>`, which reserves its own gutter; applying
  // the document gutter there too produced a second, never-painted gutter on
  // classic-scrollbar platforms. Flag the body-scrolled branches on `<html>`
  // so the CSS rule scopes to them.
  const isBodyScrolled = isPublicPage || isOnboardingPage;
  useEffect(() => {
    const root = document.documentElement;
    if (isBodyScrolled) {
      root.setAttribute("data-scroll", "body");
    } else {
      root.removeAttribute("data-scroll");
    }
    return () => {
      root.removeAttribute("data-scroll");
    };
  }, [isBodyScrolled]);

  useEffect(() => {
    if (!isLoading && !isAuthenticated && !isPublicPage) {
      // Session END (expired / invalidated cookie → `/api/auth/me` 401). Wipe
      // every client-side cache that can hold the previous account's health
      // data before bouncing to login, so it never leaks to the next account
      // on a shared device. Logout does the same from `useLogout`; this covers
      // the expiry path that logout never runs through. Best-effort; the
      // redirect proceeds regardless.
      void clearOfflineCachesForSessionEnd();
      router.replace("/auth/login");
    }
  }, [isLoading, isAuthenticated, isPublicPage, router]);

  // Redirect non-admins away from /admin
  useEffect(() => {
    if (
      !isLoading &&
      isAuthenticated &&
      isAdminPage &&
      user?.role !== "ADMIN"
    ) {
      router.replace("/");
    }
  }, [isLoading, isAuthenticated, isAdminPage, user?.role, router]);

  // v1.4.22 C4 — onboarding redirect moved to proxy.ts so it lands on
  // the first server response instead of post-hydration. The proxy
  // reads the `hl_onboarding` cookie (mirrored from the DB by the auth
  // routes) and 307s to /onboarding before this shell ever paints. The
  // previous `useEffect`-based redirect caused a brief dashboard flash
  // for users with `onboardingCompletedAt === null`.

  // Public pages (login, register) — render without any nav. Resolved
  // BEFORE the auth-loading gate: a public page never needs the
  // `/api/auth/me` round-trip to paint, so blocking it on `isLoading`
  // only delayed the login form behind a spinner.
  if (isPublicPage) {
    // Long-form legal pages render edge-to-edge with their own chrome.
    if (isStandalonePublicPage) {
      return <>{children}</>;
    }
    return (
      <div className="flex h-dvh flex-col">
        {demoMode ? <DemoBanner /> : null}
        <MaintainershipBanner />
        <main
          id="main-content"
          className="flex flex-1 items-center justify-center px-4"
        >
          {children}
        </main>
      </div>
    );
  }

  // Admin pages stay behind the auth gate while `/api/auth/me` is in
  // flight: the role is unknown until the payload lands, and mounting
  // `/admin/*` children early would fire admin queries that 403 for a
  // non-admin before the redirect effect can move them away.
  if (isLoading && isAdminPage) {
    return (
      <div className="flex h-dvh items-center justify-center" role="status">
        <Loader2 className="text-primary h-6 w-6 animate-spin motion-reduce:animate-none" />
        <span className="sr-only">{t("nav.loadingScreen")}</span>
      </div>
    );
  }

  // Auth RESOLVED as unauthenticated — hold a spinner while the
  // redirect effect above replaces the route with /auth/login.
  if (!isLoading && !isAuthenticated) {
    return (
      <div className="flex h-dvh items-center justify-center" role="status">
        <Loader2 className="text-primary h-6 w-6 animate-spin motion-reduce:animate-none" />
        <span className="sr-only">{t("nav.loadingScreen")}</span>
      </div>
    );
  }

  // While `/api/auth/me` is still in flight the shell renders the full
  // app chrome + children immediately (the chrome components own their
  // null-user skeletons, pages own their data skeletons). This takes the
  // auth round-trip off the first-paint critical path: page-level
  // queries fire in parallel with `/api/auth/me` instead of behind it.
  // `src/proxy.ts` has already refused cookie-less requests to
  // protected routes, so the unauthenticated-flash window is limited to
  // expired/invalid sessions — those resolve into the redirect branch
  // above as soon as the 401 lands.

  // Onboarding page — minimal shell, no sidebar/nav
  if (isOnboardingPage) {
    return (
      <>
        {showUnlockNotifier && user?.id ? (
          <AchievementUnlockNotifier userId={user.id} />
        ) : null}
        <div className="flex min-h-dvh flex-col">
          <MaintainershipBanner />
          <div className="flex flex-1 items-center justify-center px-4 py-8">
            {children}
          </div>
        </div>
      </>
    );
  }

  // Authenticated — full app shell.
  //
  // v1.4.34 IW-B — the Coach launch provider lives here (not inside
  // `app/insights/layout.tsx` anymore) so every authenticated route can
  // call `askCoach()` from the same context. Pre-hoist the drawer was
  // only reachable from `/insights/**`; the dashboard hero CTA now opens
  // it without a route hop. `<LayoutCoachMount>` consumes the same
  // context to render the drawer once at the shell level.
  //
  // v1.16.8 — `<LayoutCoachFab>` joins the shell too: the floating
  // Coach launcher renders once here for every authenticated route
  // (it hides itself on `/coach` and carries the unread-nudge
  // dot). The routed insights layout no longer mounts it.
  return (
    <CoachLaunchProvider>
      {showUnlockNotifier && user?.id ? (
        <AchievementUnlockNotifier userId={user.id} />
      ) : null}
      {/*
        Keyboard-only skip link. The non-focused state has both
        `pointer-events-none` (so a mouse click in the top-left corner
        passes through to the logo behind it) AND `-translate-y-full`
        (so even an accidental tap with stylus / touch can't activate
        it). Focus restores both — the element jumps back into the
        viewport and becomes clickable.
      */}
      <a
        href="#main-content"
        className="bg-primary text-primary-foreground pointer-events-none fixed top-2 left-2 z-[100] -translate-y-full rounded-md px-4 py-2 text-sm font-medium opacity-0 transition-transform focus:pointer-events-auto focus:translate-y-0 focus:opacity-100"
      >
        {t("nav.skipToContent")}
      </a>
      <div className="flex h-dvh flex-col md:flex-row">
        <SidebarNav />
        <div className="flex min-h-0 flex-1 flex-col">
          {/*
            v1.4.43 QoL (M5) — `<OfflineBanner>` paints only when
            `navigator.onLine === false`. Sits above the maintainership
            banner + top bar so the connection-status hint is always
            the first chrome line a user sees in the offline branch.
          */}
          <OfflineBanner />
          {/* Demo instances surface a persistent "changes are not
              saved" strip — the proxy blocks every mutation, and
              without the banner that block only surfaced as a raw API
              error after the user already filled in a form. */}
          {demoMode ? <DemoBanner /> : null}
          <MaintainershipBanner />
          <TopBar />
          <main
            id="main-content"
            // `scrollbar-gutter: stable` keeps the scroll viewport's content
            // box a fixed width whether or not the vertical scrollbar is
            // painted. Without it a route / sub-tab whose body overflows
            // (e.g. the admin "Insights Quality" section) shows the bar and
            // narrows the content box, while a shorter one (e.g.
            // "Integrations") hides it and widens the box — the `mx-auto`
            // wrapper then recentres and the whole column, including the
            // admin/settings sidebar, shifts a few px sideways on every
            // toggle. Reserving the gutter holds the layout still.
            className="flex-1 [scrollbar-gutter:stable] overflow-y-auto pb-[calc(4rem+env(safe-area-inset-bottom,0px))] md:pb-0"
          >
            {/*
              v1.4.33 IW9 — container normalised on `max-w-screen-xl`
              (1280 px) so dashboard / settings / admin / bugreport all
              hit the same content frame. Pre-v1.4.33 the dashboard
              shell capped at `max-w-[76.8rem]` (1228 px) while the
              settings/admin shells used `max-w-screen-xl`, producing a
              52 px lateral wobble on every route switch. Same audit
              note in `.planning/round-v1433-audit-polish.md` §4.2.

              v1.16.8 — the bottom padding clears the always-on Coach
              FAB (48 px button + its offset above the bottom-nav band /
              the desktop bottom-6 anchor), so the last line of content
              can always scroll out from under the floating button.
            */}
            <div className="mx-auto max-w-screen-xl px-4 pt-6 pb-20 md:px-6">
              {children}
            </div>
          </main>
        </div>
        <BottomNav />
      </div>
      <LayoutCoachMount />
      {/* v1.18.6 — the module-tour launcher lives at the shell level so its
          overlay survives the cross-page `router.push`es the tour makes. It
          self-gates: it only auto-opens on the dashboard for a user who has
          not finished/dismissed the tour, and otherwise renders null. Stays
          out of demo mode (the tour PATCHes `/api/onboarding/tour`, which the
          proxy blocks for demo visitors). */}
      {!demoMode && <TourLauncher />}
      {/* v1.16.13 — the Coach FAB stays hidden in demo mode. Its send hits
          `/api/insights/chat`, which is not in the proxy's
          `DEMO_MUTATION_ALLOWLIST`, so a demo visitor who tapped it and sent
          got a raw 403. Demo is read-only by design; the FAB has no job
          here, so it's mounted only outside demo mode. */}
      {!demoMode && <LayoutCoachFab />}
    </CoachLaunchProvider>
  );
}
