import {
  Activity,
  Droplets,
  Dumbbell,
  FlaskConical,
  Home,
  Lightbulb,
  MessagesSquare,
  Pill,
  Trophy,
  Waves,
  type LucideIcon,
} from "lucide-react";

/**
 * v1.17.1 — the single navigation information-model.
 *
 * Before this module the desktop sidebar and the mobile bottom-nav each
 * hand-curated their own destination list, and the two had drifted: the
 * sidebar listed Measurements / Mood inline but hid Workouts; the bottom
 * bar buried Measurements / Mood in "More" but promoted Workouts — and
 * the Coach, the stated differentiator, had no nav home on either. A user
 * who learned the product on one platform re-learned it on the other.
 *
 * This list is the ONE ordered destination model. Both bars render it:
 * the sidebar shows every entry in order; the bottom bar keeps its 5-slot
 * ergonomic shape (Home · Meds · capture · Insights · More) and derives
 * its "More" hub from the SAME list (every destination not already a
 * primary slot), so the two bars are re-skins of one story rather than
 * two curated lists that drift.
 */
export interface NavDestination {
  href: string;
  /** i18n key under the `nav.*` namespace. */
  tKey: string;
  icon: LucideIcon;
  /**
   * Stable onboarding-tour anchor. Matches `data-tour-id` lookups in the
   * spotlight tour — renaming silently breaks the cutout for that step.
   */
  tourId?: string;
  /** Gate the entry on the account's `cycleTrackingEnabled` flag. */
  requiresCycle?: boolean;
}

/**
 * The canonical ordered destination list. Cycle sits where it always has
 * (after Medications) and is filtered out when the account gate is off;
 * the order is otherwise identical for both surfaces.
 */
export const NAV_DESTINATIONS: ReadonlyArray<NavDestination> = [
  { href: "/", tKey: "nav.dashboard", icon: Home, tourId: "nav-dashboard" },
  {
    href: "/measurements",
    tKey: "nav.measurements",
    icon: Activity,
    tourId: "nav-measurements",
  },
  { href: "/mood", tKey: "nav.mood", icon: Waves, tourId: "nav-mood" },
  {
    href: "/medications",
    tKey: "nav.medications",
    icon: Pill,
    tourId: "nav-medications",
  },
  {
    href: "/cycle",
    tKey: "nav.cycle",
    icon: Droplets,
    tourId: "nav-cycle",
    requiresCycle: true,
  },
  {
    href: "/labs",
    tKey: "nav.labs",
    icon: FlaskConical,
    tourId: "nav-labs",
  },
  {
    href: "/insights/workouts",
    tKey: "nav.workouts",
    icon: Dumbbell,
    tourId: "nav-workouts",
  },
  {
    href: "/insights",
    tKey: "nav.insights",
    icon: Lightbulb,
    tourId: "nav-insights",
  },
  // v1.17.1 (F-3) — the Coach finally gets a single labeled nav home. It
  // was reachable from seven scattered entry points (FAB, hero CTA, empty
  // states, per-metric icons …) but nowhere in the nav, so a new user
  // could miss the differentiator entirely. The other entry points stay.
  {
    href: "/insights/coach",
    tKey: "nav.coach",
    icon: MessagesSquare,
    tourId: "nav-coach",
  },
  {
    href: "/achievements",
    tKey: "nav.achievements",
    icon: Trophy,
    tourId: "nav-achievements",
  },
];

/**
 * The ordered destinations visible to this account — drops cycle-gated
 * entries when the flag is off. Both bars start from this.
 */
export function visibleNavDestinations(
  cycleTrackingEnabled: boolean | undefined,
): NavDestination[] {
  return NAV_DESTINATIONS.filter(
    (d) => !d.requiresCycle || cycleTrackingEnabled === true,
  );
}

/**
 * Whether `href` is the active nav destination for the current `pathname`,
 * resolved against the full destination set so the most-specific entry
 * wins. Without this, a plain `startsWith("/insights")` would light up
 * Insights while the user is on its siblings `/insights/workouts` or
 * `/insights/coach` — both of which are now their own top-level nav homes.
 * The dashboard (`/`) only matches an exact path.
 */
export function isNavDestinationActive(
  href: string,
  pathname: string,
  destinations: ReadonlyArray<NavDestination> = NAV_DESTINATIONS,
): boolean {
  if (href === "/") return pathname === "/";
  const matches = (candidate: string) =>
    pathname === candidate || pathname.startsWith(`${candidate}/`);
  if (!matches(href)) return false;
  // A longer sibling that also matches is the more specific home — defer
  // to it (e.g. on `/insights/coach`, `/insights` must NOT read active).
  const moreSpecific = destinations.some(
    (d) => d.href !== href && d.href.startsWith(`${href}/`) && matches(d.href),
  );
  return !moreSpecific;
}
