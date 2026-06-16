/**
 * v1.18.0 — canonical module registry.
 *
 * The single source of truth for "what is a module" in HealthLog's
 * enable/disable foundation. Every leak-point (nav, dashboard tiles,
 * insights sections, coach snapshot, status routes, reminder jobs,
 * achievements, doctor-report / FHIR, search, quick-add) reads its gate
 * decision through `src/lib/modules/gate.ts`, which keys off the entries
 * declared here.
 *
 * Two classes of domain:
 *
 *   - CORE (always-on): weight, blood pressure, pulse, medications — the
 *     measurement engine + meds. These are NOT in `MODULE_KEYS` and have
 *     NO registry entry. They can never be disabled; the gate has no key
 *     to flip and the write endpoint refuses them. This is structural,
 *     not a runtime check future code can soften.
 *
 *   - TOGGLEABLE (the "secondary domains"): the maintainer-chosen scope
 *     below. Each carries a stable key, an i18n label + description key,
 *     a category for the Settings hub grouping, and an optional
 *     `delegatesTo` marker for the two modules whose enabled-state is
 *     owned elsewhere (no double source of truth).
 *
 * The persisted shape (`User.modulePreferencesJson`) is a DISABLED
 * allowlist: absent / empty / `true` ⇒ enabled, an explicit `false` ⇒
 * disabled. Default-on, no backfill.
 */

/**
 * Where a module's enabled-state is resolved when it is NOT owned by
 * `modulePreferencesJson` directly. Keeps a single source of truth:
 *
 *   - "cycle"  → `isCycleEnabled(gender, CycleProfile)` (the existing
 *                cycle gate; `modulePreferencesJson.cycle` is ignored).
 *   - "coach"  → `User.disableCoach` AND the operator-level assistant
 *                master flag (`getAssistantFlags().coach`); again the
 *                module blob is ignored for this key.
 *
 * Every other toggleable module has no `delegatesTo` and resolves purely
 * from `modulePreferencesJson`.
 */
export type ModuleDelegation = "cycle" | "coach";

/** Coarse grouping for the Settings "What you track" hub. */
export type ModuleCategory =
  | "tracking" // user-logged domains (mood, cycle, glucose, labs)
  | "device" // device / passive-sync domains (sleep, workouts, recovery)
  | "engagement" // gamification (achievements)
  | "intelligence" // AI-driven surfaces (coach, insights)
  | "export"; // outbound reporting (doctor report / FHIR)

export interface ModuleDefinition {
  /** Stable key — the literal used in `modulePreferencesJson` + the API. */
  key: ModuleKey;
  /** i18n key for the human-readable module name (messages/*.json). */
  labelKey: string;
  /** i18n key for the one-line "what turning this off does" explainer. */
  descriptionKey: string;
  /** Settings-hub grouping. */
  category: ModuleCategory;
  /**
   * When set, the module's enabled-state is NOT resolved from
   * `modulePreferencesJson` — the gate delegates to the named source so
   * there is exactly one source of truth. See `ModuleDelegation`.
   */
  delegatesTo?: ModuleDelegation;
  /**
   * For delegated modules only: where the real on/off control lives, so the
   * Modules hub can render a read-only "managed in X" row that deep-links to
   * the canonical control instead of a dead toggle. `href` is the in-app
   * link; `labelKey` names the destination ("Account", "Coach settings").
   */
  managedAt?: { href: string; labelKey: string };
  /**
   * v1.18.1 — BORN-GATED (opt-in / default-off). A born-gated module is
   * the inverse of the standard disabled-allowlist: it stays OFF until the
   * account explicitly enables it (`modulePreferencesJson[key] === true`).
   * Used for new optional verticals (the illness/condition journal) that
   * ship dark and only appear once the user opts in from the Modules hub.
   * The gate's `false`-disables contract still holds — an explicit `false`
   * (or simply the absent default) keeps it off — but here ONLY an explicit
   * `true` turns it on, so the surface never appears unbidden.
   */
  bornGated?: boolean;
}

/**
 * The toggleable modules — the maintainer's "secondary domains" scope.
 *
 * Declared as a const tuple so `ModuleKey` is the exact union and the
 * registry stays exhaustively typed.
 */
export const MODULE_KEYS = [
  "cycle",
  "mood",
  "sleep",
  "glucose",
  "workouts",
  "recovery",
  "labs",
  "illness",
  "achievements",
  "coach",
  "insights",
  // v1.18.1 (D3) — medications graduated from the always-on CORE set to a
  // toggleable module. Weight / blood pressure / pulse stay CORE (the
  // measurement engine is never disableable); medications is now an opt-out
  // domain so an account that does not track meds can hide the surface.
  // SURFACE-gated (nav entry, dashboard medication widget, the dedicated
  // Medikamente settings entry) — the medication data-layer routes stay
  // exempt like mood/labs so an importer / sync / cleanup keeps working and
  // re-enabling finds the rows intact.
  "medications",
  "doctorReport",
] as const;

export type ModuleKey = (typeof MODULE_KEYS)[number];

/**
 * CORE domains — the always-on measurement engine + medications. Listed
 * here for documentation + the write-endpoint denylist; they have NO
 * `ModuleDefinition` and can never appear as a toggle. A crafted
 * `{ "weight": false }` blob is inert: `weight` is not a `ModuleKey`, so
 * the gate never reads it and the PATCH validator rejects it.
 */
export const CORE_DOMAIN_KEYS = [
  "weight",
  "bloodPressure",
  "pulse",
] as const;

export type CoreDomainKey = (typeof CORE_DOMAIN_KEYS)[number];

const CORE_DOMAIN_SET: ReadonlySet<string> = new Set(CORE_DOMAIN_KEYS);

/** True for the four always-on core domains (never disableable). */
export function isCoreDomain(key: string): key is CoreDomainKey {
  return CORE_DOMAIN_SET.has(key);
}

/**
 * The registry. Order is the Settings-hub display order (grouped by
 * category in the UI; this flat order is the canonical iteration order).
 *
 * `insights` decision (documented): disabling `insights` hides only the
 * AI-ANALYSIS surfaces — the Daily Briefing, the per-metric AI status
 * cards, the correlation narration, the Health-Score explainer. It does
 * NOT hide the raw weight / BP / pulse charts or any measurement data:
 * those are core and render from live measurements regardless. `insights`
 * is the narrative layer, not the data layer. (The operator-level
 * assistant master flag is a separate, server-wide kill-switch; this
 * per-user toggle sits below it.)
 *
 * `coach` is the per-user opt-out half of the existing two-layer model
 * (`User.disableCoach` AND the operator master flag). It is surfaced here
 * so the Modules hub lists it alongside its siblings, but it delegates —
 * the module blob never owns it.
 */
export const MODULE_REGISTRY: Readonly<Record<ModuleKey, ModuleDefinition>> =
  Object.freeze({
    cycle: {
      key: "cycle",
      labelKey: "modules.cycle.label",
      descriptionKey: "modules.cycle.description",
      category: "tracking",
      delegatesTo: "cycle",
      // The real on/off lives in the Account section's cycle-tracking card.
      managedAt: {
        href: "/settings/account#cycle-tracking",
        labelKey: "settings.sections.account.title",
      },
    },
    mood: {
      key: "mood",
      labelKey: "modules.mood.label",
      descriptionKey: "modules.mood.description",
      category: "tracking",
    },
    glucose: {
      key: "glucose",
      labelKey: "modules.glucose.label",
      descriptionKey: "modules.glucose.description",
      category: "tracking",
    },
    labs: {
      key: "labs",
      labelKey: "modules.labs.label",
      descriptionKey: "modules.labs.description",
      category: "tracking",
    },
    illness: {
      key: "illness",
      labelKey: "modules.illness.label",
      descriptionKey: "modules.illness.description",
      category: "tracking",
      // Ships dark — only appears once the account opts in from the
      // Modules hub. Default-off, no nag, retrospective-only.
      bornGated: true,
    },
    sleep: {
      key: "sleep",
      labelKey: "modules.sleep.label",
      descriptionKey: "modules.sleep.description",
      category: "device",
    },
    workouts: {
      key: "workouts",
      labelKey: "modules.workouts.label",
      descriptionKey: "modules.workouts.description",
      category: "device",
    },
    recovery: {
      key: "recovery",
      labelKey: "modules.recovery.label",
      descriptionKey: "modules.recovery.description",
      category: "device",
    },
    achievements: {
      key: "achievements",
      labelKey: "modules.achievements.label",
      descriptionKey: "modules.achievements.description",
      category: "engagement",
    },
    coach: {
      key: "coach",
      labelKey: "modules.coach.label",
      descriptionKey: "modules.coach.description",
      category: "intelligence",
      delegatesTo: "coach",
      // The real on/off lives in the dedicated Coach settings section.
      managedAt: {
        href: "/settings/coach",
        labelKey: "settings.sections.coach.title",
      },
    },
    insights: {
      key: "insights",
      labelKey: "modules.insights.label",
      descriptionKey: "modules.insights.description",
      category: "intelligence",
    },
    medications: {
      key: "medications",
      labelKey: "modules.medications.label",
      descriptionKey: "modules.medications.description",
      category: "tracking",
    },
    doctorReport: {
      key: "doctorReport",
      labelKey: "modules.doctorReport.label",
      descriptionKey: "modules.doctorReport.description",
      category: "export",
    },
  });

const MODULE_KEY_SET: ReadonlySet<string> = new Set(MODULE_KEYS);

/** True when `key` is a known toggleable module. */
export function isModuleKey(key: string): key is ModuleKey {
  return MODULE_KEY_SET.has(key);
}

/** The two delegated keys, resolved by their existing source of truth. */
export function moduleDelegatesTo(key: ModuleKey): ModuleDelegation | undefined {
  return MODULE_REGISTRY[key].delegatesTo;
}

/**
 * v1.18.1 — true for a born-gated (opt-in / default-off) module. The gate
 * flips its default from on to off for these keys: they require an explicit
 * `modulePreferencesJson[key] === true` to enable.
 */
export function isBornGatedModule(key: ModuleKey): boolean {
  return MODULE_REGISTRY[key].bornGated === true;
}
