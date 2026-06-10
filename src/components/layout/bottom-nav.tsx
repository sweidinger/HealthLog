"use client";

import {
  Activity,
  Bell,
  Bug,
  Droplets,
  Dumbbell,
  Home,
  Lightbulb,
  MoreHorizontal,
  Pill,
  Plus,
  Settings,
  Trophy,
  Waves,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
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
  icon: typeof Home;
}

// v1.12.x — iOS-parity bottom bar (additive middle-path).
//
// The mobile bar is a 5-slot shape: Home · Meds · Log(center) ·
// Insights · More — mirroring the native client. The center slot is a
// capture ACTION (not a destination): it opens a picker that routes to
// the existing measurement / medication / mood quick-entry surfaces
// (see `<CapturePicker>`).
//
// PRIMARY_LEFT / PRIMARY_RIGHT are the two anchor pairs that flank the
// center action. The previous strip (Home · Measurements · Mood ·
// Medications · Insights) carried Measurements and Mood inline; those
// stay fully reachable — through the center capture picker AND the More
// hub below — so nothing is orphaned. On desktop the sidebar still
// lists every destination.
const PRIMARY_LEFT: ReadonlyArray<NavLink> = [
  { href: "/", tKey: "nav.dashboard", icon: Home },
  { href: "/medications", tKey: "nav.medications", icon: Pill },
];

const PRIMARY_RIGHT: ReadonlyArray<NavLink> = [
  { href: "/insights", tKey: "nav.insights", icon: Lightbulb },
];

// The "More" hub — a real hub of the remaining top-level destinations,
// not just an overflow bucket. Measurements and Mood live here (they
// left the always-visible strip when the center capture action took the
// middle slot), alongside Workouts, Achievements, Notifications and
// Settings. Every entry is an existing top-level route.
const MORE_HUB: ReadonlyArray<NavLink> = [
  { href: "/measurements", tKey: "nav.measurements", icon: Activity },
  { href: "/mood", tKey: "nav.mood", icon: Waves },
  { href: "/insights/workouts", tKey: "nav.workouts", icon: Dumbbell },
  { href: "/achievements", tKey: "nav.achievements", icon: Trophy },
  { href: "/notifications", tKey: "nav.notifications", icon: Bell },
  { href: "/settings/account", tKey: "nav.settings", icon: Settings },
];

// v1.15.0 — the cycle entry, spliced into the More hub only when the
// account's `cycleTrackingEnabled` gate is true. Hidden for everyone else.
const CYCLE_HUB_ITEM: NavLink = {
  href: "/cycle",
  tKey: "nav.cycle",
  icon: Droplets,
};

// The bug-report entry, spliced into the More hub under the same
// `bugReportEnabled` operator flag that gates the desktop sidebar
// entry. Pre-splice the route was desktop-only — a phone user had no
// path to `/bugreport` at all.
const BUGREPORT_HUB_ITEM: NavLink = {
  href: "/bugreport",
  tKey: "nav.bugreport",
  icon: Bug,
};

export function BottomNav() {
  const pathname = usePathname();
  const { t } = useTranslations();
  const { user } = useAuth();
  const { bugReportEnabled } = useAppSettings();
  const [moreOpen, setMoreOpen] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);

  // v1.15.0 — splice the cycle entry into the More hub after Mood when the
  // account's gate is on, so it never appears for accounts without it.
  const cycleAwareHub: ReadonlyArray<NavLink> = user?.cycleTrackingEnabled
    ? [MORE_HUB[0], MORE_HUB[1], CYCLE_HUB_ITEM, ...MORE_HUB.slice(2)]
    : MORE_HUB;
  // Bug report sits directly before Settings (the hub's last entry)
  // when the operator flag is on — same gate as the desktop sidebar.
  const moreHub: ReadonlyArray<NavLink> = bugReportEnabled
    ? [
        ...cycleAwareHub.slice(0, -1),
        BUGREPORT_HUB_ITEM,
        cycleAwareHub[cycleAwareHub.length - 1],
      ]
    : cycleAwareHub;

  function isActiveLink(href: string) {
    return href === "/" ? pathname === "/" : pathname.startsWith(href);
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
                  <span className="text-sm font-medium">{t(item.tKey)}</span>
                </Link>
              );
            })}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
