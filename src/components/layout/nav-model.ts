import {
  Activity,
  Bell,
  Bug,
  Droplets,
  Dumbbell,
  FlaskConical,
  HeartPulse,
  Home,
  Lightbulb,
  MessagesSquare,
  Pill,
  Settings,
  Stethoscope,
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
  // v1.17.1 — Vorsorge (preventive-care) gets a top-level nav home in the
  // clinical spine, peer to Labs and Recovery. It is a first-class tracking
  // surface ("wann muss ich was wo machen"), not pure configuration, so it
  // belongs in the model both bars render — not buried three taps deep under
  // Settings → Reminders. The Reminders hub still links to it; this is the
  // direct front door so the customer knows where it lives.
  {
    href: "/vorsorge",
    tKey: "nav.vorsorge",
    icon: Stethoscope,
    tourId: "nav-vorsorge",
  },
  {
    href: "/insights/workouts",
    tKey: "nav.workouts",
    icon: Dumbbell,
    tourId: "nav-workouts",
  },
  // v1.17.1 — the Recovery surface gets a nav home alongside Workouts. It
  // hosts the WHOOP / Polar device-native recovery + strain scores that were
  // stored end-to-end but had no page. Like Workouts it is shown to every
  // account (the page itself data-gates each block, so a non-wearable user
  // lands on a calm empty note rather than a broken surface).
  {
    href: "/insights/recovery",
    tKey: "nav.recovery",
    icon: HeartPulse,
    tourId: "nav-recovery",
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
    href: "/coach",
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
 * v1.17.1 (F-1 residue) — the shared UTILITY tail.
 *
 * Bug Report, Settings and Notifications are reachable on both bars but are
 * not feature destinations: on desktop they live in the sidebar footer +
 * avatar menu, on mobile at the tail of the "More" hub. They used to be a
 * second hand-curated list on each bar — the exact drift the one-model
 * contract above set out to kill, just pushed down a level. This list is
 * the single source both bars consume for the tail, so the two surfaces
 * can no longer disagree on which utility links exist or in which order.
 *
 * Order is the footer/hub order: Bug Report (gated) → Settings →
 * Notifications. `bugReportGated` entries drop when the operator flag is
 * off, exactly as the feature list drops cycle-gated entries.
 *
 * Admin is intentionally NOT here: it is a role-gated, desktop-sidebar-only
 * surface (the mobile bar never exposes it), so it is not a shared tail
 * destination and stays local to the sidebar.
 */
export interface NavUtilityDestination {
  href: string;
  /** i18n key under the `nav.*` namespace. */
  tKey: string;
  icon: LucideIcon;
  /** Drop the entry unless the operator's bug-report flag is on. */
  bugReportGated?: boolean;
}

export const NAV_UTILITY_DESTINATIONS: ReadonlyArray<NavUtilityDestination> = [
  { href: "/bugreport", tKey: "nav.bugreport", icon: Bug, bugReportGated: true },
  { href: "/settings/account", tKey: "nav.settings", icon: Settings },
  { href: "/notifications", tKey: "nav.notifications", icon: Bell },
];

/**
 * The utility tail visible to this account — drops the bug-report entry
 * when the operator flag is off. Both bars consume this for their tail
 * (the sidebar footer + avatar menu, the bottom-nav More hub) so the two
 * surfaces share one definition of the utility links.
 */
export function visibleUtilityDestinations(
  bugReportEnabled: boolean | undefined,
): NavUtilityDestination[] {
  return NAV_UTILITY_DESTINATIONS.filter(
    (d) => !d.bugReportGated || bugReportEnabled === true,
  );
}

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
 * The mobile bottom-nav's three always-visible primary slots
 * (Home · Meds · Insights). Every other feature destination falls into the
 * "More" hub. Kept here (not in the bar) so the headline F-1 invariant —
 * the hub is the shared feature list minus the primary slots, plus the
 * shared utility tail — is a tested model function, not inline bar logic.
 */
export const BOTTOM_NAV_PRIMARY_SLOT_HREFS: ReadonlyArray<string> = [
  "/",
  "/medications",
  "/insights",
];

export interface MobileMoreHubEntry {
  href: string;
  tKey: string;
  icon: LucideIcon;
}

/**
 * The ordered "More" hub for the mobile bottom-nav: every visible feature
 * destination that isn't a primary slot, in model order, followed by the
 * shared utility tail (Bug Report behind its flag, Settings, Notifications).
 * The desktop sidebar renders the same feature list inline and consumes the
 * same utility tail in its footer + avatar menu, so the two bars cannot
 * drift into two hand-curated lists.
 */
export function mobileMoreHubDestinations(opts: {
  cycleTrackingEnabled: boolean | undefined;
  bugReportEnabled: boolean | undefined;
}): MobileMoreHubEntry[] {
  const features = visibleNavDestinations(opts.cycleTrackingEnabled)
    .filter((d) => !BOTTOM_NAV_PRIMARY_SLOT_HREFS.includes(d.href))
    .map((d) => ({ href: d.href, tKey: d.tKey, icon: d.icon }));
  const tail = visibleUtilityDestinations(opts.bugReportEnabled).map((d) => ({
    href: d.href,
    tKey: d.tKey,
    icon: d.icon,
  }));
  return [...features, ...tail];
}

/**
 * Whether `href` is the active nav destination for the current `pathname`,
 * resolved against the full destination set so the most-specific entry
 * wins. Without this, a plain `startsWith("/insights")` would light up
 * Insights while the user is on its sibling `/insights/workouts`, which
 * is its own nav home (Coach lives at the top-level `/coach`).
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
  // to it (e.g. on `/insights/workouts`, `/insights` must NOT read active).
  const moreSpecific = destinations.some(
    (d) => d.href !== href && d.href.startsWith(`${href}/`) && matches(d.href),
  );
  return !moreSpecific;
}
