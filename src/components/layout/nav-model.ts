import {
  Activity,
  Bell,
  Bug,
  Droplets,
  FlaskConical,
  Home,
  Lightbulb,
  MessagesSquare,
  Pill,
  Settings,
  Stethoscope,
  Thermometer,
  Trophy,
  Waves,
  type LucideIcon,
} from "lucide-react";

import type { ModuleKey } from "@/lib/modules/registry";

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
  /**
   * v1.18.0 — gate the entry on a per-user module toggle. When set, the
   * entry is dropped unless the account's resolved module map (from
   * `GET /api/auth/me`'s `modules`) has the key enabled. Core destinations
   * (weight / BP / pulse + always-on pages) carry no key and always render.
   * `cycle` and `coach` are delegated keys (cycle → gender +
   * opt-in, coach → operator flag + per-user opt-out); the auth/me map
   * already reflects that delegation, so reading them here is correct and
   * not a re-derivation.
   */
  requiresModule?: ModuleKey;
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
  {
    href: "/mood",
    tKey: "nav.mood",
    icon: Waves,
    tourId: "nav-mood",
    requiresModule: "mood",
  },
  {
    href: "/medications",
    tKey: "nav.medications",
    icon: Pill,
    tourId: "nav-medications",
    // v1.18.1 (D3) — medications graduated from a CORE domain to a toggleable
    // module; the nav entry now drops when the account turns the module off.
    requiresModule: "medications",
  },
  {
    href: "/cycle",
    tKey: "nav.cycle",
    icon: Droplets,
    tourId: "nav-cycle",
    requiresModule: "cycle",
  },
  {
    href: "/labs",
    tKey: "nav.labs",
    icon: FlaskConical,
    tourId: "nav-labs",
    requiresModule: "labs",
  },
  // v1.18.1 — the illness/condition journal sits in the clinical spine
  // next to Labs. Born-gated: `requiresModule: "illness"` reads the
  // opt-in `illness` key from the resolved module map, so the entry is
  // absent until the account turns the module on from the Modules hub.
  {
    href: "/illness",
    tKey: "nav.illness",
    icon: Thermometer,
    tourId: "nav-illness",
    requiresModule: "illness",
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
    // v1.18.1 — deliberately NOT module-gated (no `requiresModule`). Unlike
    // labs / illness / cycle (opt-in clinical-spine verticals born off by
    // default), preventive-care reminders are a CORE surface available to
    // every account from birth: a reminder can target core vitals
    // (weight / BP / pulse) that are never behind a module toggle, and a
    // free-text "Großes Blutbild" reminder belongs to no module at all.
    // Gating the entry would orphan reminders the user can still create.
  },
  // v1.18.0 — Workouts and Recovery both left the left-nav: each already
  // surfaces as an Insights tab-strip pill (`/insights/workouts` gated on
  // a workout row, `/insights/recovery` always present), so neither is a
  // top-level `NAV_DESTINATIONS` entry any more.
  {
    href: "/insights",
    tKey: "nav.insights",
    icon: Lightbulb,
    tourId: "nav-insights",
    requiresModule: "insights",
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
    requiresModule: "coach",
  },
  {
    href: "/achievements",
    tKey: "nav.achievements",
    icon: Trophy,
    tourId: "nav-achievements",
    requiresModule: "achievements",
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
 * A partial map of `ModuleKey → enabled`. This is the `modules` field
 * `GET /api/auth/me` returns (resolved server-side, with cycle + coach
 * already delegated). A `false` value hides the gated entry; a missing
 * key, an `undefined` map (auth not yet loaded), or `true` keeps it —
 * fail-open, mirroring the gate's default-on contract so a stale /me
 * payload never blanks the nav.
 */
export type ModuleVisibilityMap = Partial<Record<ModuleKey, boolean>>;

/**
 * Whether a destination is visible under the given module map. Core
 * destinations (no `requiresModule`) always pass; a gated entry passes
 * unless its module resolves to an explicit `false`.
 */
function isNavDestinationVisible(
  d: NavDestination,
  modules: ModuleVisibilityMap | undefined,
): boolean {
  if (!d.requiresModule) return true;
  return modules?.[d.requiresModule] !== false;
}

/**
 * The ordered destinations visible to this account — drops a module-gated
 * entry (mood, cycle, labs, coach, achievements …) when its module is
 * disabled in the account's resolved module map. Both bars start from this.
 * v1.18.0 — cycle is no longer a bespoke boolean: it is `requiresModule:
 * "cycle"` and reads the delegated `cycle` key from the same map.
 */
export function visibleNavDestinations(
  modules: ModuleVisibilityMap | undefined,
): NavDestination[] {
  return NAV_DESTINATIONS.filter((d) => isNavDestinationVisible(d, modules));
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
  modules: ModuleVisibilityMap | undefined;
  bugReportEnabled: boolean | undefined;
}): MobileMoreHubEntry[] {
  const features = visibleNavDestinations(opts.modules)
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
