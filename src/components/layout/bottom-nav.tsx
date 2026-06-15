"use client";

import {
  Home,
  Lightbulb,
  MoreHorizontal,
  Pill,
  Plus,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { medicationsPrefetchIntentProps } from "@/lib/queries/prefetch-medications";
import {
  isNavDestinationActive,
  mobileMoreHubDestinations,
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
// The bar keeps its ergonomic 5-slot shape, but the hub is computed by the
// model's `mobileMoreHubDestinations()` (feature list minus the primary
// slots, plus the shared utility tail) — so the two surfaces tell one story
// instead of two hand-curated ones that drift, and the headline invariant
// is a tested model function rather than inline bar logic.
const PRIMARY_LEFT: ReadonlyArray<NavLink> = [
  { href: "/", tKey: "nav.dashboard", icon: Home },
  { href: "/medications", tKey: "nav.medications", icon: Pill },
];

const PRIMARY_RIGHT: ReadonlyArray<NavLink> = [
  { href: "/insights", tKey: "nav.insights", icon: Lightbulb },
];

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

  // v1.17.1 (F-1) — the More hub is the model-computed hub: every visible
  // feature destination that isn't a primary slot, plus the shared utility
  // tail. Cycle + Bug Report are gated by the same flags the sidebar uses,
  // so the two surfaces gate identically and cannot drift.
  const moreHub = useMemo<ReadonlyArray<NavLink>>(
    () =>
      mobileMoreHubDestinations({
        cycleTrackingEnabled: user?.cycleTrackingEnabled,
        bugReportEnabled,
      }),
    [user?.cycleTrackingEnabled, bugReportEnabled],
  );

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
                  {/* v1.18.0 — the label must stay inside the tile across all
                      six locales. The longest single-word label (German
                      "Benachrichtigungen") has no natural break opportunity, so
                      `min-w-0` alone is not enough — the unbroken word forces the
                      span past the grid track and overflows the tile. `min-w-0`
                      lets the flex child shrink below its content width,
                      `break-words` introduces a break inside the long word, and
                      the auto-height tile (`min-h-14`) absorbs the second line. */}
                  <span className="min-w-0 break-words text-sm font-medium leading-tight">
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
