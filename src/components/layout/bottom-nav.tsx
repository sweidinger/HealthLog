"use client";

import {
  Bell,
  Bug,
  Home,
  Lightbulb,
  MoreHorizontal,
  Pill,
  Plus,
  Settings,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { medicationsPrefetchIntentProps } from "@/lib/queries/prefetch-medications";
import {
  isNavDestinationActive,
  visibleNavDestinations,
} from "@/components/layout/nav-model";
import { useMemo, useState } from "react";
import { useAppSettings } from "@/components/app-settings-provider";
import { useAuth } from "@/hooks/use-auth";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { CapturePicker } from "@/components/layout/capture-picker";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";

interface NavLink {
  href: string;
  tKey: string;
  icon: LucideIcon;
}

// v1.12.x — iOS-parity bottom bar (additive middle-path).
//
// The mobile bar is a 5-slot shape: Home · Meds · Log(center) ·
// Insights · More — mirroring the native client. The center slot is a
// capture ACTION (not a destination): it opens a picker that routes to
// the existing measurement / medication / mood quick-entry surfaces
// (see `<CapturePicker>`).
//
// v1.17.1 (F-1) — the two always-visible flanking anchors and the "More"
// hub are now BOTH derived from the one shared destination model
// (`nav-model.ts`), the same ordered list the desktop sidebar renders.
// The bar keeps its ergonomic 5-slot shape, but every destination that
// isn't a primary slot falls into the hub in the model's order — so the
// two surfaces tell one story instead of two hand-curated ones that drift.
const PRIMARY_SLOT_HREFS = ["/", "/medications", "/insights"] as const;

const PRIMARY_LEFT: ReadonlyArray<NavLink> = [
  { href: "/", tKey: "nav.dashboard", icon: Home },
  { href: "/medications", tKey: "nav.medications", icon: Pill },
];

const PRIMARY_RIGHT: ReadonlyArray<NavLink> = [
  { href: "/insights", tKey: "nav.insights", icon: Lightbulb },
];

// Mobile-only hub conveniences that have no main-list home on desktop
// (the sidebar reaches them through its footer + avatar menu). They sit
// at the tail of the hub, after every shared destination.
const NOTIFICATIONS_HUB_ITEM: NavLink = {
  href: "/notifications",
  tKey: "nav.notifications",
  icon: Bell,
};
const SETTINGS_HUB_ITEM: NavLink = {
  href: "/settings/account",
  tKey: "nav.settings",
  icon: Settings,
};

// The bug-report entry, appended under the same `bugReportEnabled`
// operator flag that gates the desktop sidebar entry. Pre-splice the
// route was desktop-only — a phone user had no path to `/bugreport`.
const BUGREPORT_HUB_ITEM: NavLink = {
  href: "/bugreport",
  tKey: "nav.bugreport",
  icon: Bug,
};

export function BottomNav() {
  const pathname = usePathname();
  const { t } = useTranslations();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  // v1.16.7 — touch intent on the medications tab starts the list
  // request before the navigation commits (see sidebar-nav).
  const medsIntent = medicationsPrefetchIntentProps(queryClient);
  const { bugReportEnabled } = useAppSettings();
  const [moreOpen, setMoreOpen] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);

  // v1.17.1 (F-1) — the More hub is every shared destination that isn't an
  // always-visible primary slot, in the model's order, plus the mobile-only
  // Notifications / Settings conveniences (and Bug Report behind its flag).
  // Cycle is filtered by the same account gate the sidebar uses, so the two
  // surfaces gate it identically.
  const moreHub = useMemo<ReadonlyArray<NavLink>>(() => {
    const shared = visibleNavDestinations(user?.cycleTrackingEnabled)
      .filter((d) => !PRIMARY_SLOT_HREFS.includes(d.href as never))
      .map((d) => ({ href: d.href, tKey: d.tKey, icon: d.icon }));
    const tail: NavLink[] = [NOTIFICATIONS_HUB_ITEM, SETTINGS_HUB_ITEM];
    if (bugReportEnabled) tail.unshift(BUGREPORT_HUB_ITEM);
    return [...shared, ...tail];
  }, [user?.cycleTrackingEnabled, bugReportEnabled]);

  function isActiveLink(href: string) {
    return isNavDestinationActive(href, pathname);
  }

  // The "More" entry is treated as active when any of its children
  // is the current page — gives the user a clue that they've drilled
  // into a sub-route via the hub.
  const moreActive = moreHub.some((item) => isActiveLink(item.href));

  function renderPrimary(item: NavLink) {
    const isActive = isActiveLink(item.href);
    return (
      <Link
        key={item.href}
        href={item.href}
        aria-label={t(item.tKey)}
        aria-current={isActive ? "page" : undefined}
        {...(item.href === "/medications" ? medsIntent : {})}
        // Touch target sized to WCAG 2.5.5 (44×44 CSS px). The
        // outer min-h-11 min-w-11 is the actual hit area; the icon
        // stays visually centered at 20px so the design doesn't shift.
        className={cn(
          "relative flex min-h-11 min-w-11 flex-1 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2",
          isActive
            ? "text-primary"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <item.icon className="h-5 w-5" />
        {isActive && (
          <span className="bg-primary absolute bottom-1.5 h-1 w-1 rounded-full" />
        )}
      </Link>
    );
  }

  return (
    <>
      {/* v1.4.33 F14 — bar height and safe-area defence so the bar can
          never overlap the last viewport line of scrollable page content.
          `min-h-16` floors the bar at 64px; `pb-[env(safe-area-inset-bottom)]`
          reserves the home-indicator inset on iOS / iPadOS PWA installs;
          `bg-card` + `border-t` give the bar a clean visual edge so page
          content that scrolls under the bar is occluded, not bleeding
          through. */}
      <nav
        aria-label={t("nav.mobileNavigation")}
        className="bg-card border-border fixed bottom-0 left-0 z-50 min-h-16 w-full border-t pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:hidden"
      >
        <div className="mx-auto flex h-16 max-w-lg items-stretch justify-around px-1">
          {PRIMARY_LEFT.map(renderPrimary)}

          {/* Center capture action — a labeled button (NOT a link) that
              opens the capture picker. Elevated as a Floating-Action-
              Button: it sits larger than the flanking tabs (h-14 = 56px,
              well above the 44px tap-target floor), lifts above the bar
              with a negative top margin, and carries a filled-primary
              collar (a `bg-card` ring that punches it out of the bar) plus
              a stronger shadow so it reads as the bar's primary CTA rather
              than a fifth flush tab. */}
          <div className="flex flex-1 items-center justify-center">
            <button
              type="button"
              aria-label={t("nav.capture.title")}
              aria-haspopup="dialog"
              aria-expanded={captureOpen}
              onClick={() => setCaptureOpen(true)}
              data-testid="bottom-nav-capture"
              className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring/70 ring-card -mt-5 flex h-14 w-14 items-center justify-center rounded-full shadow-lg ring-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
            >
              <Plus className="h-7 w-7" />
            </button>
          </div>

          {PRIMARY_RIGHT.map(renderPrimary)}

          <button
            type="button"
            aria-label={t("nav.more")}
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            aria-current={moreActive ? "page" : undefined}
            onClick={() => setMoreOpen(true)}
            className={cn(
              "relative flex min-h-11 min-w-11 flex-1 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2",
              moreActive
                ? "text-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
            data-testid="bottom-nav-more"
          >
            <MoreHorizontal className="h-5 w-5" />
            {moreActive && (
              <span className="bg-primary absolute bottom-1.5 h-1 w-1 rounded-full" />
            )}
          </button>
        </div>
      </nav>

      <CapturePicker open={captureOpen} onOpenChange={setCaptureOpen} />

      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent
          side="bottom"
          // The sheet auto-sizes to its content; padding-bottom respects
          // the iOS safe area so the inner buttons stay reachable above
          // the home-indicator on iPhone-X-class devices.
          className="rounded-t-xl pb-[calc(env(safe-area-inset-bottom)+1rem)] md:hidden"
          data-testid="bottom-nav-more-sheet"
        >
          <SheetHeader>
            <SheetTitle>{t("nav.moreSheetTitle")}</SheetTitle>
            <SheetDescription>{t("nav.moreSheetDescription")}</SheetDescription>
          </SheetHeader>
          <div className="grid grid-cols-2 gap-2 px-4 pb-4">
            {moreHub.map((item) => {
              const isActive = isActiveLink(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMoreOpen(false)}
                  aria-current={isActive ? "page" : undefined}
                  // v1.12 — `min-h-14` matches the capture-picker tiles so
                  // the equivalent tappable rows share one height at this
                  // tier (and the larger row is a more comfortable target).
                  className={cn(
                    "border-border flex min-h-14 items-center gap-3 rounded-lg border px-4 py-3 transition-colors",
                    isActive
                      ? "text-primary bg-primary/5"
                      : "text-foreground hover:bg-accent/40",
                  )}
                >
                  <item.icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                  <span className="min-w-0 text-sm font-medium leading-tight">
                    {t(item.tKey)}
                  </span>
                </Link>
              );
            })}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
