/**
 * v1.4.25 W4 — slug → metric mapping for the routed insights sub-pages.
 *
 * The mother page (`/insights`) hosts the overview (hero + briefing +
 * trends + advisor). Each named slug below is a sub-route that focuses
 * one metric. Charts on the sub-pages still use the dashboard chart-cog
 * surface — see `chartKey` strings in `src/lib/dashboard-layout.ts`
 * (`CHART_OVERLAY_KEYS`).
 *
 * v1.8.0 — the slugs are English. They were German through v1.7.x; the
 * naming-convention ADR (`docs/adr/0001-insights-naming-convention.md`)
 * settled the surface: UI copy stays localised (resolved through `t()`
 * keys), but internal identifiers — route slugs, tile ids, query keys —
 * are English. Legacy `/insights/<de-slug>` URLs 301-redirect to their
 * English target via `next.config.ts` `redirects()`.
 *
 * `medications` carries no `MeasurementType[]` because medication
 * compliance is event-driven (`MedicationIntakeEvent` rows) rather than
 * time-series `Measurement` rows; the page fetches that data via the
 * existing `/api/insights/comprehensive` consumer.
 *
 * `bmi` lists `WEIGHT` because BMI is derived client-side —
 * `WEIGHT / (heightCm/100)^2` — and the chart sets `valueMode="bmi"` on
 * `<HealthChart>`. The user's height lives on the profile, so there is
 * no separate height series to fetch.
 */
/**
 * Single source of truth for the routed insights sub-pages. The slug
 * enum, the slug array, and the per-slug metric list all derive from
 * the keys of this record — adding a sub-page is a one-place change.
 */
// v1.4.33 F9 — order follows the MeasurementCategory overlay
// (`src/lib/measurements/categories.ts`):
//
//   vitals → body → activity → sleep → cardiovascular → mood → events
//
// v1.4.34 IW-D — the five wave-A HealthKit entries (HRV, resting HR,
// SpO2, body temperature, active energy) added in v1.4.32 share a
// presentation group on the routed tab strip. Each sub-page keeps its
// own URL and own page component — only the strip presentation changes
// so the five pills collapse behind one "Vitalwerte" / "Vitals" parent
// pill with a popover sub-list. The `group: "vitals"` field below
// drives that grouping; the canonical order inside the popover follows
// the strip order. The earlier inline pills (`pulse`, `blood-pressure`,
// `weight`, `bmi`, `sleep`, `mood`, `medications`, `workouts`) stay
// flat — they predate v1.4.32 and the maintainer's audit kept them as
// direct entries.
const SUB_PAGE_METRIC = {
  // ── vitals ──
  "blood-pressure": ["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA", "PULSE"],
  pulse: ["PULSE"],
  oxygen: ["OXYGEN_SATURATION"],
  "body-temperature": ["BODY_TEMPERATURE"],
  // v1.7.0 — respiratory rate joins the vitals cluster.
  "respiratory-rate": ["RESPIRATORY_RATE"],
  // ── body composition ──
  weight: ["WEIGHT"],
  // BMI is derived from WEIGHT + profile height (no separate series).
  bmi: ["WEIGHT"],
  // v1.7.0 — Withings / Apple body-composition tail.
  "body-water": ["TOTAL_BODY_WATER"],
  "bone-mass": ["BONE_MASS"],
  "fat-free-mass": ["FAT_FREE_MASS"],
  "fat-mass": ["FAT_MASS"],
  "muscle-mass": ["MUSCLE_MASS"],
  "visceral-fat": ["VISCERAL_FAT"],
  "lean-body-mass": ["LEAN_BODY_MASS"],
  // ── activity ──
  // v1.12 — Steps gains a routed sub-page. Stored as `ACTIVITY_STEPS`;
  // the tile already surfaced on the dashboard but the metric was never
  // listed here, so it never appeared in the Insights tab strip / sub-page
  // nav despite the user having step data.
  steps: ["ACTIVITY_STEPS"],
  "active-energy": ["ACTIVE_ENERGY_BURNED"],
  // v1.4.32 — workouts surface; the page reads `Workout` rows directly
  // through `useWorkouts()` rather than the `summaries` map, so the
  // metric list stays empty.
  workouts: [],
  // v1.7.0 — activity + Apple-Health Mobility cluster.
  "flights-climbed": ["FLIGHTS_CLIMBED"],
  "walking-distance": ["WALKING_RUNNING_DISTANCE"],
  "walking-steadiness": ["WALKING_STEADINESS"],
  "walking-heart-rate": ["WALKING_HEART_RATE_AVERAGE"],
  "walking-asymmetry": ["WALKING_ASYMMETRY"],
  "double-support-time": ["WALKING_DOUBLE_SUPPORT"],
  "step-length": ["WALKING_STEP_LENGTH"],
  "walking-speed": ["WALKING_SPEED"],
  // v1.10.0 — VO2 max (cardio fitness) gains a dedicated sub-page so it
  // carries the generic metric-status assessment instead of riding as a
  // bare chart-row on the pulse page.
  "cardio-fitness": ["VO2_MAX"],
  // v1.10.0 — Apple-Health Mobility additions.
  falls: ["FALL_COUNT"],
  "six-minute-walk": ["SIX_MINUTE_WALK_DISTANCE"],
  "stair-ascent-speed": ["STAIR_ASCENT_SPEED"],
  "stair-descent-speed": ["STAIR_DESCENT_SPEED"],
  // ── sleep ──
  sleep: ["SLEEP_DURATION"],
  // v1.10.0 — sleep breathing-disturbance index joins the sleep cluster.
  "breathing-disturbances": ["BREATHING_DISTURBANCES"],
  // ── cardiovascular ──
  "resting-pulse": ["RESTING_HEART_RATE"],
  // v1.17.0 — HRV surfaces both flavours: SDNN (`HEART_RATE_VARIABILITY`,
  // Apple / Fitbit) and RMSSD (`HRV_RMSSD`, Oura / Polar / WHOOP). A
  // ring / strap user stores only RMSSD; listing both keeps the tab,
  // pill, and dashboard tile lit whichever source the user has.
  hrv: ["HEART_RATE_VARIABILITY", "HRV_RMSSD"],
  // v1.7.0 — Withings cardiovascular risk markers.
  "pulse-wave-velocity": ["PULSE_WAVE_VELOCITY"],
  "vascular-age": ["VASCULAR_AGE"],
  // v1.10.0 — cardio recovery (post-exercise HR drop) joins the
  // cardiovascular cluster.
  "cardio-recovery": ["CARDIO_RECOVERY"],
  // ── hearing (v1.7.0) — audio-exposure cluster ──
  "environmental-audio": ["AUDIO_EXPOSURE_ENV"],
  "headphone-audio": ["AUDIO_EXPOSURE_HEADPHONE"],
  "audio-events": ["AUDIO_EXPOSURE_EVENT"],
  // ── environment (v1.7.0) ──
  daylight: ["TIME_IN_DAYLIGHT"],
  // ── metabolic (v1.7.0) ──
  "blood-glucose": ["BLOOD_GLUCOSE"],
  "skin-temperature": ["SKIN_TEMPERATURE"],
  // v1.10.0 — overnight wrist temperature joins the metabolic cluster.
  "wrist-temperature": ["WRIST_TEMPERATURE"],
  // ── mood ──
  mood: ["MOOD"],
  // ── events (medication adherence is event-driven; no measurement series) ──
  medications: [],
} as const satisfies Record<string, readonly string[]>;

export type SubPageSlug = keyof typeof SUB_PAGE_METRIC;

export const SUB_PAGE_SLUGS = Object.keys(SUB_PAGE_METRIC) as SubPageSlug[];

/**
 * v1.4.34 IW-D — strip-presentation grouping. Only `"vitals"` is in
 * use today; every other slug renders as a top-level pill. The group
 * key is rendered through a single parent pill that opens a popover
 * containing the grouped sub-pages. Adding a new group is a one-row
 * change here plus a matching label key under
 * `insights.tabStrip.<group>Parent.*` in every locale.
 */
// v1.7.0 — the new metric clusters each collapse behind a parent pill
// so the strip stays scannable as the sub-page count grows. The flat
// pills (pulse, blood-pressure, weight, bmi, sleep, mood, medications,
// workouts) stay direct entries as before.
export type SubPageGroup =
  | "vitals"
  | "body"
  | "activity"
  | "cardiovascular"
  | "hearing"
  | "environment"
  | "metabolic";

export const SUB_PAGE_GROUP: Partial<Record<SubPageSlug, SubPageGroup>> = {
  // vitals
  hrv: "vitals",
  "resting-pulse": "vitals",
  oxygen: "vitals",
  "body-temperature": "vitals",
  "active-energy": "vitals",
  "respiratory-rate": "vitals",
  // body composition (v1.7.0)
  "body-water": "body",
  "bone-mass": "body",
  "fat-free-mass": "body",
  "fat-mass": "body",
  "muscle-mass": "body",
  "visceral-fat": "body",
  "lean-body-mass": "body",
  // activity / mobility (v1.7.0)
  steps: "activity",
  "flights-climbed": "activity",
  "walking-distance": "activity",
  "walking-steadiness": "activity",
  "walking-heart-rate": "activity",
  "walking-asymmetry": "activity",
  "double-support-time": "activity",
  "step-length": "activity",
  "walking-speed": "activity",
  // cardiovascular (v1.7.0)
  "pulse-wave-velocity": "cardiovascular",
  "vascular-age": "cardiovascular",
  // hearing (v1.7.0)
  "environmental-audio": "hearing",
  "headphone-audio": "hearing",
  "audio-events": "hearing",
  // environment (v1.7.0)
  daylight: "environment",
  // metabolic (v1.7.0)
  "blood-glucose": "metabolic",
  "skin-temperature": "metabolic",
  // ── v1.10.0 — additive HealthKit signals (WX-A) ──
  // activity / mobility cluster
  "cardio-fitness": "activity",
  falls: "activity",
  "six-minute-walk": "activity",
  "stair-ascent-speed": "activity",
  "stair-descent-speed": "activity",
  // vitals cluster (breathing sits with respiratory rate)
  "breathing-disturbances": "vitals",
  // cardiovascular cluster
  "cardio-recovery": "cardiovascular",
  // metabolic cluster (overnight wrist reading)
  "wrist-temperature": "metabolic",
};

/**
 * v1.4.34 IW-D — canonical order of the sub-pages inside each parent
 * popover. The strip iterates `SUB_PAGE_SLUGS`, so a member's position
 * in the popover follows its position in that array.
 */
export const SUB_PAGE_GROUP_ORDER: Record<
  SubPageGroup,
  readonly SubPageSlug[]
> = {
  vitals: SUB_PAGE_SLUGS.filter((slug) => SUB_PAGE_GROUP[slug] === "vitals"),
  body: SUB_PAGE_SLUGS.filter((slug) => SUB_PAGE_GROUP[slug] === "body"),
  activity: SUB_PAGE_SLUGS.filter(
    (slug) => SUB_PAGE_GROUP[slug] === "activity",
  ),
  cardiovascular: SUB_PAGE_SLUGS.filter(
    (slug) => SUB_PAGE_GROUP[slug] === "cardiovascular",
  ),
  hearing: SUB_PAGE_SLUGS.filter((slug) => SUB_PAGE_GROUP[slug] === "hearing"),
  environment: SUB_PAGE_SLUGS.filter(
    (slug) => SUB_PAGE_GROUP[slug] === "environment",
  ),
  metabolic: SUB_PAGE_SLUGS.filter(
    (slug) => SUB_PAGE_GROUP[slug] === "metabolic",
  ),
};

/**
 * v1.15.14 W2 — manager grouping for the "Anpassen" → "Detailseiten
 * verwalten" surface.
 *
 * The tab strip only assigns a `SUB_PAGE_GROUP` to the long-tail metrics
 * that collapse behind a popover parent pill; the eight legacy flat pills
 * (blood-pressure, pulse, weight, bmi, sleep, mood, medications, workouts)
 * render as direct entries and carry NO `SUB_PAGE_GROUP`. The sub-page
 * MANAGER, by contrast, lists EVERY slug grouped under a category header,
 * so it needs a total slug → group mapping that covers the flat pills too
 * and adds the three categories the tab strip never groups (`sleep`,
 * `mood`, `events`). This map is that total assignment; it is a superset
 * of `SUB_PAGE_GROUP` (every `SUB_PAGE_GROUP` entry agrees with it) plus a
 * fallback for the flat slugs. Single source of truth for the manager —
 * the tab-strip nav grouping stays `SUB_PAGE_GROUP` exactly as before.
 */
export type ManagerGroup =
  | "vitals"
  | "body"
  | "activity"
  | "sleep"
  | "cardiovascular"
  | "hearing"
  | "environment"
  | "metabolic"
  | "mood"
  | "events";

/**
 * Render order of the manager's category sections — mirrors the
 * MeasurementCategory overlay the rest of insights follows
 * (vitals → body → activity → sleep → cardiovascular → hearing →
 * environment → metabolic → mood → events).
 */
export const MANAGER_GROUP_ORDER: readonly ManagerGroup[] = [
  "vitals",
  "body",
  "activity",
  "sleep",
  "cardiovascular",
  "hearing",
  "environment",
  "metabolic",
  "mood",
  "events",
];

/** Explicit group for the flat tab-strip slugs (those `SUB_PAGE_GROUP` omits). */
const FLAT_SLUG_MANAGER_GROUP: Partial<Record<SubPageSlug, ManagerGroup>> = {
  "blood-pressure": "vitals",
  pulse: "vitals",
  weight: "body",
  bmi: "body",
  workouts: "activity",
  sleep: "sleep",
  mood: "mood",
  medications: "events",
};

/**
 * Total slug → manager-group assignment. A slug grouped by the tab strip
 * keeps that group; a flat slug falls back to {@link FLAT_SLUG_MANAGER_GROUP}.
 * Every slug resolves (asserted by the manager-coverage test).
 */
export const SUB_PAGE_MANAGER_GROUP: Record<SubPageSlug, ManagerGroup> =
  Object.fromEntries(
    SUB_PAGE_SLUGS.map((slug) => [
      slug,
      (SUB_PAGE_GROUP[slug] as ManagerGroup | undefined) ??
        FLAT_SLUG_MANAGER_GROUP[slug] ??
        "vitals",
    ]),
  ) as unknown as Record<SubPageSlug, ManagerGroup>;

/**
 * Slugs per manager group, in `SUB_PAGE_SLUGS` order. The manager renders
 * one collapsible section per group following {@link MANAGER_GROUP_ORDER},
 * each listing these slugs.
 */
export const SUB_PAGE_MANAGER_GROUP_SLUGS: Record<
  ManagerGroup,
  readonly SubPageSlug[]
> = Object.fromEntries(
  MANAGER_GROUP_ORDER.map((group) => [
    group,
    SUB_PAGE_SLUGS.filter((slug) => SUB_PAGE_MANAGER_GROUP[slug] === group),
  ]),
) as unknown as Record<ManagerGroup, readonly SubPageSlug[]>;

/**
 * v1.22 — reverse lookup: a measurement type → the routed insights sub-page
 * slug that focuses it, when one exists.
 *
 * Built from {@link SUB_PAGE_METRIC}, preferring the slug whose metric list
 * is exactly `[type]` so an ambiguous type resolves to its dedicated
 * single-metric page rather than a multi-metric cluster: `PULSE` → `pulse`
 * (not `blood-pressure`), `WEIGHT` → `weight` (not the derived `bmi`). When
 * two single-metric pages list the same type (`weight` + `bmi` both list
 * `WEIGHT`) the first in `SUB_PAGE_SLUGS` order wins (`weight`). A type that
 * only ever appears on a multi-metric page (the two blood-pressure
 * components, the two HRV flavours) falls back to that page. Types with no
 * sub-page at all (BODY_FAT, RECOVERY_SCORE, the `*_EVENT` series, most
 * device scores) are absent — the caller falls back to the filtered
 * measurements list.
 */
export const TYPE_TO_SUB_PAGE_SLUG: Readonly<Record<string, SubPageSlug>> =
  (() => {
    const map: Record<string, SubPageSlug> = {};
    // Pass 1 — exact single-metric pages win (first occurrence in slug order).
    for (const slug of SUB_PAGE_SLUGS) {
      const metrics = SUB_PAGE_METRIC[slug];
      if (metrics.length !== 1) continue;
      const type = metrics[0];
      if (!(type in map)) map[type] = slug;
    }
    // Pass 2 — multi-metric pages fill any type a single-metric page misses.
    for (const slug of SUB_PAGE_SLUGS) {
      const metrics = SUB_PAGE_METRIC[slug];
      if (metrics.length === 1) continue;
      for (const type of metrics) {
        if (!(type in map)) map[type] = slug;
      }
    }
    return map;
  })();

/**
 * The insights sub-page slug for a measurement type, or `undefined` when no
 * routed card focuses it. See {@link TYPE_TO_SUB_PAGE_SLUG} for the
 * ambiguity-resolution rule.
 */
export function subPageSlugForType(type: string): SubPageSlug | undefined {
  return TYPE_TO_SUB_PAGE_SLUG[type];
}

/**
 * Mother-page route. Kept here as a named constant so call sites
 * never have to hard-code the string.
 */
export const INSIGHTS_OVERVIEW_PATH = "/insights" as const;
