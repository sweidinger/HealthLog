/**
 * Centralized TanStack Query key factory.
 *
 * Every useQuery/invalidateQueries call should go through this factory so that
 * mutations invalidate the right consumers. Hard-coded string arrays drifted in
 * the past (e.g. ["measurements"] didn't invalidate ["analytics"] on the
 * dashboard), so treat this file as the single source of truth.
 */

import type { QueryClient, QueryKey } from "@tanstack/react-query";

export const queryKeys = {
  auth: () => ["auth"] as const,
  /**
   * v1.4.40 W-RSC — the `useAuth` hook's `["auth", "me"]` shape was a
   * recurring source of factory drift (audit H1 — "`useAuth` uses
   * `["auth", "me"]` but `queryKeys.auth()` returns `["auth"]`"). Both
   * shapes share the `["auth"]` prefix so existing prefix-invalidations
   * still match, but the centralised name makes the call site
   * obviously factory-routed.
   */
  authMe: () => ["auth", "me"] as const,
  authRegistrationStatus: () => ["auth", "registration-status"] as const,
  /**
   * v1.4.40 W-RSC — Settings → AI surfaces and the targets editor
   * subscribe to the user-thresholds API. Centralise the key so a
   * future rename (e.g. `["user","limits"]`) doesn't drift across the
   * three call sites (settings/thresholds-editor-section,
   * settings/ai-section, targets/target-edit-sheet).
   */
  userThresholds: () => ["user", "thresholds"] as const,
  /**
   * v1.7.0 — Settings → Display metric/imperial control reads its
   * current value from `GET /api/auth/me/unit-preference`. The PATCH
   * mutation also invalidates `authMe()` so `useAuth().unitPreference`
   * (and every chart display transform that keys off it) re-renders
   * without a manual reload.
   */
  userUnitPreference: () => ["user", "unit-preference"] as const,

  measurements: () => ["measurements"] as const,
  moodEntries: () => ["mood-entries"] as const,

  /**
   * v1.11.5 — last-night hypnogram (`GET /api/sleep/night`). The `date`
   * discriminator lets the night-picker step back through recent nights
   * without colliding caches; `undefined` is the most-recent night.
   */
  sleepNight: (date?: string) => ["sleep-night", date ?? "latest"] as const,

  /**
   * v1.4.33 IW2 — the analytics queryKey now optionally carries a
   * `slice` discriminator so the dashboard tile-strip can subscribe to
   * the slim `?slice=summaries` server slice (IW1 / C1) without
   * colliding with the thick-payload consumers on the Insights tree.
   * Calling `queryKeys.analytics()` without a slice keeps the legacy
   * shape `["analytics"]` so mutation invalidations and the bulk-key
   * lists below stay byte-identical.
   */
  analytics: (slice?: "summaries") =>
    slice ? (["analytics", slice] as const) : (["analytics"] as const),
  /**
   * v1.9.0 — single-metric period-over-period range read
   * (`GET /api/analytics/range`). A dedicated cache slot per `(type, range)`
   * so switching the time-range pills is a cheap cache hit after the first
   * fetch and never collides with the shared `["analytics", "summaries"]`
   * slot the dashboard tile-strip subscribes to. `["analytics"]` is a prefix
   * so a blanket `queryKeys.analytics()` invalidation still reaches it.
   */
  analyticsRange: (type: string, range: string) =>
    ["analytics", "range", type, range] as const,
  moodAnalytics: () => ["mood-analytics"] as const,
  /**
   * v1.8.5 — pre-computed mood-insights aggregates (heatmap, distribution,
   * weekday, tag breakdown, cross-metric correlations) for the Mood
   * Insights page. Read-only; invalidated on a mood write through the
   * `moodDependentKeys` fan-out below.
   */
  moodInsights: () => ["mood-insights"] as const,
  /**
   * v1.8.5 — structured mood-tag taxonomy catalog (global reference
   * data, identical for every user). Read by the mood-logging form's
   * tag-category capture surface. Not invalidated on a mood write — the
   * catalog only changes on a migration / admin edit, so a long
   * `staleTime` is fine.
   */
  moodTagCatalog: () => ["mood-tag-catalog"] as const,

  /**
   * v1.7.0 W6 — unified dashboard first-paint snapshot. One client cell
   * hydrates every above-the-fold tile from `GET /api/dashboard/snapshot`,
   * replacing the four independent analytics-slim / analytics-thick /
   * mood / widget-layout cells. A measurement / mood / medication /
   * widget / insight write evicts the matching server cache bucket via
   * `src/lib/cache/invalidate.ts`; the client read carries the same
   * 60 s `staleTime` as `DASHBOARD_QUERY_OPTS` so a warm return-to-
   * dashboard is a free cache hit.
   */
  dashboardSnapshot: () => ["dashboard", "snapshot"] as const,

  insightsRoot: () => ["insights"] as const,
  insightsComprehensive: () => ["insights", "comprehensive"] as const,
  insightsTargets: () => ["insights", "targets"] as const,
  /**
   * Shared cache key for the rich `/api/insights/generate` advisor
   * payload. Every surface that subscribes under this key shares the
   * same cache so a regenerate on one surface refreshes the others
   * without a second LLM round-trip.
   */
  insightsAdvisor: () => ["insights", "advisor"] as const,
  /**
   * v1.11.0 — period-narrative summary (`/api/insights/narrative?period=…`).
   * Keyed by period + locale so the week and month summaries cache
   * independently and a locale switch fetches the matching prose.
   */
  insightsNarrative: (period: string, locale: string) =>
    ["insights", "narrative", period, locale] as const,
  insightsBpStatus: (locale: string) =>
    ["insights", "blood-pressure-status", locale] as const,
  insightsWeightStatus: (locale: string) =>
    ["insights", "weight-status", locale] as const,
  insightsPulseStatus: (locale: string) =>
    ["insights", "pulse-status", locale] as const,
  insightsBmiStatus: (locale: string) =>
    ["insights", "bmi-status", locale] as const,
  insightsMoodStatus: (locale: string) =>
    ["insights", "mood-status", locale] as const,
  insightsMedicationComplianceStatus: (locale: string) =>
    ["insights", "medication-compliance-status", locale] as const,
  /**
   * v1.8.7.1 — per-metric insight assessment for the HealthKit metric
   * sub-pages. One generic route (`/api/insights/metric-status?metric=…`)
   * backs every HealthKit metric, so the key is parameterised by the
   * metric id alongside the locale rather than minting a bespoke factory
   * entry per metric. The seven bespoke `*-status` routes above keep
   * their own keys; this one covers the ~29 generic HealthKit pages.
   */
  insightsMetricStatus: (metric: string, locale: string) =>
    ["insights", "metric-status", metric, locale] as const,
  /**
   * v1.8.7.1 — mutationKey for the on-demand full-warm POST
   * (`/api/insights/pregenerate`). Lives in the factory so the bare-array
   * ESLint rule stays satisfied; the warm enqueues every assessment
   * generation on the worker, so there is no read cache to invalidate
   * here — the existing status queries pick up the warmed text via their
   * own stale-while-revalidate.
   */
  insightsPregenerate: () => ["insights", "pregenerate"] as const,
  /**
   * v1.10.0 — categorical events (WX-B). The device-flagged event
   * awareness timeline (`/api/insights/rhythm-events`). No locale segment
   * — the payload is verdicts + timestamps; the surface localises its own
   * prose. The `["insights"]` prefix keeps it in the standard insights
   * invalidation fan-out (an Apple Health batch write that lands an event
   * row busts it via the prefix).
   */
  insightsRhythmEvents: () => ["insights", "rhythm-events"] as const,
  /**
   * v1.10.0 — derived-wellness metrics. One generic route
   * (`/api/insights/derived?metric=…[&type=…]`) backs the vitals
   * dashboard tiles, the composite score-anatomy view, and the home
   * wellness strip — all through the one `useDerivedMetric` hook.
   *
   * One generic route backs every derived metric (sleep score, readiness,
   * coincident-deviation, vitals baseline, …); the optional sub-type is the
   * chosen vital for `VITALS_BASELINE`. The fourth tuple slot is always
   * present (`null` when no sub-type) so the cache never poisons between a
   * 3-element and a 4-element shape for the same metric prefix. Pure compute
   * over the rollup tier — a measurement write keeps it fresh by construction
   * (next read sees new buckets), so the `["insights"]` prefix carries the
   * invalidation fan-out.
   */
  insightsDerived: (metric: string, type?: string | null) =>
    ["insights", "derived", metric, type ?? null] as const,
  /**
   * v1.10.0 — batched derived-metric read (`/api/insights/derived/batch`).
   * One request resolves the whole dashboard grid server-side instead of N
   * concurrent single-metric reads sharing the Prisma pool. Keyed by the
   * sorted token list so the same grid always hits one cache entry; sits
   * under the `["insights", "derived"]` prefix so a measurement-write
   * invalidation fan-out reaches it exactly like the single-metric reads.
   */
  insightsDerivedBatch: (tokens: readonly string[]) =>
    ["insights", "derived", "batch", [...tokens].sort().join(",")] as const,
  /**
   * v1.10.0 — FDR-controlled correlation discovery
   * (`/api/insights/correlations`). Read-only descriptive surface; the
   * `["insights"]` prefix keeps it in the existing invalidation fan-out.
   */
  insightsCorrelations: () => ["insights", "correlations"] as const,

  medications: () => ["medications"] as const,
  medicationDetail: (id: string) => ["medications", id] as const,
  medicationComplianceChart: (medicationId: string) =>
    ["compliance-chart-inline", medicationId] as const,
  /**
   * v1.4.42 W3-QUERYKEY-LONGTAIL — per-medication compliance KPI used
   * by `medication-card` + `glp1-medication-card`. Centralising lets
   * the intake mutation invalidate every compliance read through the
   * `["medications"]` prefix instead of one bare-literal at a time.
   */
  medicationCompliance: (medicationId: string) =>
    ["medications", medicationId, "compliance"] as const,
  medicationCadence: (medicationId: string) =>
    ["medications", medicationId, "cadence"] as const,
  medicationGlp1Details: (medicationId: string) =>
    ["medications", medicationId, "glp1-details"] as const,
  medicationIntakeDrugLevelChart: (medicationId: string) =>
    ["medications", medicationId, "intake", "drug-level-chart"] as const,
  /**
   * v1.4.42 — intake-history list with sort / paging / status filter.
   * The opaque params object lives at index 4 so the
   * `["medications", id, "intake", "list"]` prefix invalidates every
   * sort/page combination on an intake mutation.
   */
  medicationIntakeList: (
    medicationId: string,
    params: {
      sortBy: string;
      sortDir: string;
      limit: number;
      offset: number;
      status: string;
    },
  ) =>
    [
      "medications",
      medicationId,
      "intake",
      "list",
      params.sortBy,
      params.sortDir,
      params.limit,
      params.offset,
      params.status,
    ] as const,
  /**
   * v1.4.40 W-RSC — the dashboard-level compliance chart (aggregate
   * across every scheduled medication) was a bare `["medication-
   * compliance-chart", days]` key; route it through the factory so
   * `medicationDependentKeys` invalidates it on intake-mutation just
   * like the per-medication compliance-chart-inline tile. `days` is the
   * range (7 / 30 / 90); kept as the only param so the prefix
   * `["dashboard-medication-compliance"]` invalidates every range at
   * once.
   */
  dashboardMedicationCompliance: (days: number) =>
    ["dashboard-medication-compliance", days] as const,
  medicationPhaseConfig: (medicationId: string) =>
    ["phase-config", medicationId] as const,
  /**
   * v1.5.5 F-1 H-2 — per-medication api-endpoint status (enabled +
   * active-token-count) used by the detail-page Externe Integration
   * row. The key rides under the `["medications", id, …]` prefix so
   * `medicationDependentKeys` catches it on token mint / disable.
   * Centralising the tuple closes the bare-array bypass the
   * useMemo inside `<ApiTokensRow>` was using.
   */
  medicationApiEndpoint: (medicationId: string) =>
    ["medications", medicationId, "api-endpoint"] as const,

  gamificationAchievements: () => ["gamification", "achievements"] as const,

  passkeys: () => ["passkeys"] as const,

  notificationsPreferences: () => ["notifications", "preferences"] as const,
  notificationsStatus: () => ["notifications", "status"] as const,

  settingsGlobalServices: () => ["settings", "global-services"] as const,
  settingsNtfy: () => ["settings", "ntfy"] as const,
  settingsReminderThresholds: () =>
    ["settings", "reminder-thresholds"] as const,

  /** v1.8.5 — user-level injection-site preferences (global exclusion). */
  injectionSitePrefs: () => ["settings", "injection-site-prefs"] as const,

  /**
   * v1.4.41 W-FRONTEND-FACTORY — Settings → AI surfaces (provider chain,
   * insights settings, user provider preference) and the targets editor
   * all read these endpoints; centralising the keys keeps invalidation
   * symmetrical with the user-thresholds + auth surfaces.
   */
  insightsSettings: () => ["insights", "settings"] as const,
  insightsProviderChain: () => ["insights", "provider-chain"] as const,
  insightsGlp1Timeline: (limit: number | string) =>
    ["insights", "glp1-timeline", limit] as const,
  userAiProvider: () => ["user", "ai-provider"] as const,
  userProfile: () => ["user", "profile"] as const,
  /**
   * v1.7.0 — the roaming notification prefs blob behind
   * `GET/PATCH /api/auth/me/notification-prefs` (medication delivery
   * default + mood reminder hour). Distinct from
   * `notificationsPreferences()` (the per-event push toggles on the
   * `/notifications` page) so the two never collide in the cache.
   */
  authNotificationPrefs: () => ["auth", "me", "notification-prefs"] as const,

  apiVersion: () => ["api", "version"] as const,
  publicVersion: () => ["public", "version"] as const,
  researchMode: () => ["research-mode"] as const,
  moodlogStatus: () => ["moodlog-status"] as const,
  integrationsStatus: () => ["integrations", "status"] as const,

  /** v1.11.0 — owner's clinician share links (Settings → Sharing). */
  shareLinks: () => ["share-links"] as const,

  featureFlags: () => ["feature-flags"] as const,
  coachPrefs: () => ["coach-prefs"] as const,
  coachFacts: () => ["coach-facts"] as const,

  /**
   * v1.4.41 — admin surfaces. Pre-fix every admin section declared its
   * own bare-literal `["admin", "<name>"]`. Routing through the factory
   * lets a single rename change every consumer in lockstep.
   */
  adminAiQuality: () => ["admin", "ai-quality"] as const,
  adminAppLogs: (
    traceId: string | undefined,
    action: string | undefined,
    level: string | undefined,
    range: string | undefined,
  ) => ["admin", "app-logs", traceId, action, level, range] as const,
  adminAssistantFlags: () => ["admin", "settings", "assistant-flags"] as const,
  adminBackups: () => ["admin", "backups"] as const,
  adminCoachFeedback: () => ["admin", "coach-feedback"] as const,
  adminFeedback: (status: string) => ["admin", "feedback", status] as const,
  adminFeedbackRoot: () => ["admin", "feedback"] as const,
  adminHostMetrics: (window: string) =>
    ["admin", "host-metrics", window] as const,
  adminAuditActions: () => ["admin", "audit-log", "actions"] as const,
  adminAuditOverview: () => ["admin", "audit-log", "overview-preview"] as const,
  /**
   * v1.4.42 W3-QUERYKEY-LONGTAIL — paginated + filtered audit-log
   * read used by the login-overview admin section. The `filtered`
   * discriminator at index 2 keeps the no-arg `adminAuditLog(filter)`
   * cache slot byte-distinct so its consumers don't collide.
   */
  adminAuditLogFiltered: (params: {
    filter: string;
    page: number;
    perPage: number;
    actor: string;
    actionFilter: string;
    target: string;
    range: string;
  }) =>
    [
      "admin",
      "audit-log",
      "filtered",
      params.filter,
      params.page,
      params.perPage,
      params.actor,
      params.actionFilter,
      params.target,
      params.range,
    ] as const,

  tokens: () => ["tokens"] as const,
  telegram: () => ["telegram"] as const,
  telegramSettings: () => ["telegram", "settings"] as const,
  withings: () => ["withings"] as const,
  /**
   * v1.4.42 W3-QUERYKEY-LONGTAIL — the per-card Withings status read.
   * Shares the `["withings"]` prefix with `withings()` so a disconnect
   * mutation invalidates both at once.
   */
  withingsStatus: () => ["withings", "status"] as const,
  whoop: () => ["whoop"] as const,
  /**
   * Per-card WHOOP status read. Shares the `["whoop"]` prefix with `whoop()`
   * so a disconnect / credentials mutation invalidates both at once.
   */
  whoopStatus: () => ["whoop", "status"] as const,
  // v1.12.0 — Fitbit/Pixel integration card, mirroring the WHOOP keys.
  fitbit: () => ["fitbit"] as const,
  /**
   * Per-card Fitbit status read. Shares the `["fitbit"]` prefix with `fitbit()`
   * so a disconnect / credentials mutation invalidates both at once.
   */
  fitbitStatus: () => ["fitbit", "status"] as const,

  // v1.4.32 — workout list + detail caches. `workouts()` is the
  // root key invalidated by the batch-ingest mutation; the recent +
  // detail sub-keys ride underneath so the dashboard tile and the
  // detail page share a cache slot with the list page.
  workouts: () => ["workouts"] as const,
  workoutsRecent: () => ["workouts", "recent"] as const,
  /**
   * v1.4.42 W3-QUERYKEY-LONGTAIL — the `useWorkouts` hook used to
   * spread `workoutsRecent()` and append an opts object inline. The
   * factory now owns the full shape so the hook never reaches for a
   * literal-array wrapper.
   */
  workoutsRecentList: (opts: {
    limit?: number;
    offset?: number;
    since?: string;
    sportType?: string;
  }) => ["workouts", "recent", opts] as const,
  workoutDetail: (id: string) => ["workouts", id] as const,

  adminSettings: () => ["admin", "settings"] as const,
  adminStatus: () => ["admin", "status"] as const,
  adminUsers: () => ["admin", "users"] as const,
  adminTokens: () => ["admin", "tokens"] as const,
  adminAuditLog: (filter: unknown) => ["admin", "audit-log", filter] as const,

  bugreportStatus: () => ["bugreport", "status"] as const,

  /**
   * v1.4.22 W5 reconcile (Code-LOW-5) — `["user", "dashboardWidgets"]`
   * was duplicated as a literal at three call sites (dashboard,
   * insights, settings/dashboard-layout). One typo turns into a
   * silent cache miss + extra fetch; the centralised key defends
   * against the same query-key-collision class as `analytics()`.
   */
  dashboardWidgets: () => ["user", "dashboardWidgets"] as const,

  /**
   * v1.5.5 — per-user insights tile layout (mirrors
   * `dashboardWidgets`). The Settings UI + the iOS client + the
   * `/insights` shell all read this key; the PUT mutation invalidates
   * it on save so every consumer paints the new layout in lockstep.
   */
  insightsLayout: () => ["user", "insightsLayout"] as const,

  /**
   * v1.4.25 W5e — per-user, per-metric-class source priority. The
   * Settings → Sources surface reads + writes this key; saving
   * invalidates `analytics()` because the cumulative-metric aggregator
   * folds the new priority into the SLEEP_DURATION daily total
   * immediately.
   */
  sourcePriority: () => ["auth", "source-priority"] as const,

  /**
   * v1.4.40 W-RSC — per-chart daily-aggregate fetch from the dashboard
   * + insights chart row. Pre-fix the key was bare `["chart-data", …]`
   * across the codebase, which excluded it from
   * `measurementDependentKeys` and left chart caches stale for up to
   * 60 s after a measurement save (audit-C2). Routing through the
   * factory pulls every variant under a single
   * `["chart-data"]` invalidation prefix so a mutation refreshes the
   * tile strip + the chart row in lockstep.
   *
   * The shape carries the heavy parameter list because the chart query
   * is bounded by metric set, value mode, BMI divisor, timezone, and
   * fetch window; the factory packs those into a single tuple to keep
   * the cache layout byte-identical with the pre-v1.4.40 layout.
   */
  chartData: (
    types: string,
    valueMode: string,
    bmiDivisor: string | number,
    timezone: string,
    fromIso: string,
    toIso: string,
    // v1.7.0 — display-time value scale (e.g. m/s → km/h via 3.6).
    // Defaults to 1 so every pre-v1.7.0 caller packs a byte-identical
    // tuple; a non-default scale re-keys the cache so the processed
    // (scaled) series doesn't bleed across charts that share the
    // underlying raw window.
    valueScale: number = 1,
  ) =>
    [
      "chart-data",
      types,
      valueMode,
      bmiDivisor,
      timezone,
      fromIso,
      toIso,
      valueScale,
    ] as const,

  /**
   * v1.8.5 — bounded recent-timestamp read powering the
   * measurement-diversity nudge on an insights category page. Keyed by
   * the page's `MeasurementType` so each metric caches its own window.
   * Shares the `measurement-dependent` invalidation prefix below so an
   * edit/delete in the values subpage re-runs the clustering check.
   */
  measurementDiversity: (type: string) =>
    ["measurement-diversity", type] as const,

  /**
   * v1.11.4 item J — bounded 30-day daily-aggregate read backing the
   * Insights Trends-row deterministic caption (`trend-descriptor.ts`).
   * Keyed by the comma-joined measurement type set so each card's slot
   * caches its own small window (≤ 30 rollup rows). Distinct from
   * `chartData(...)` so the caption never re-keys when the chart's
   * internal value-mode / scale / range state changes; it only needs the
   * raw 30-day series to derive direction + magnitude. Shares the
   * `["trend-series"]` invalidation prefix below so a measurement write
   * refreshes the caption in lockstep with the chart.
   */
  insightsTrendSeries: (types: string) => ["trend-series", types] as const,

  /**
   * v1.15.0 — cycle-tracking surfaces. `cycle()` is the root prefix every
   * cycle write invalidates through (`cycleDependentKeys` below). The
   * calendar read is keyed by `(from, to)` so paging the month strip caches
   * each window independently; the history + profile reads each get their
   * own slot. A day-log / period write evicts the whole `["cycle"]` prefix
   * so the calendar, the wheel, the predictions panel, and the history
   * stats repaint in lockstep.
   */
  cycle: () => ["cycle"] as const,
  cycleCalendar: (from: string, to: string) =>
    ["cycle", "calendar", from, to] as const,
  cycleHistory: (limit: number) => ["cycle", "history", limit] as const,
  cycleProfile: () => ["cycle", "profile"] as const,
  /** The UNGATED enable/prefs read (`/api/auth/me/cycle-prefs`) — the settings
   * on-ramp reads this so a non-FEMALE account can opt in before the gated
   * cycle page is reachable. */
  cyclePrefs: () => ["cycle", "prefs"] as const,
  cycleInsights: () => ["cycle", "insights"] as const,
  cycleDayLog: (date: string) => ["cycle", "day-log", date] as const,
  /** The caller's own custom symptoms (decrypted labels) the log-day sheet
   * merges into the seeded chip grid. */
  cycleCustomSymptoms: () => ["cycle", "custom-symptoms"] as const,
};

/**
 * Keys that should be invalidated when a measurement is created, updated or
 * deleted. Kept here so dashboards, insights, and targets always stay in sync.
 *
 * v1.4.40 W-RSC — `["chart-data"]` prefix now lives in the bundle so a
 * fresh measurement evicts every per-chart daily-aggregate cache. The
 * prefix matches every key returned from `queryKeys.chartData(…)` via
 * TanStack's hierarchical-prefix semantics — adding a measurement now
 * refreshes the tile strip *and* the chart row in lockstep instead of
 * leaving the chart row 60 s stale (audit C2).
 */
export const measurementDependentKeys = [
  queryKeys.measurements(),
  queryKeys.analytics(),
  queryKeys.insightsRoot(),
  queryKeys.insightsTargets(),
  queryKeys.gamificationAchievements(),
  ["chart-data"] as const,
  // v1.8.5 — re-run the diversity-nudge clustering when readings change.
  ["measurement-diversity"] as const,
  // v1.11.4 item J — refresh the Trends-row deterministic caption series
  // when a reading changes, in lockstep with the chart row above it.
  ["trend-series"] as const,
  // v1.11.5 — refresh the last-night hypnogram when sleep rows change.
  ["sleep-night"] as const,
];

/**
 * Keys that should be invalidated when a mood entry is created, updated or
 * deleted.
 */
export const moodDependentKeys = [
  queryKeys.moodEntries(),
  queryKeys.moodAnalytics(),
  queryKeys.moodInsights(),
  queryKeys.insightsRoot(),
  queryKeys.insightsTargets(),
  queryKeys.gamificationAchievements(),
];

/**
 * Keys invalidated when medications change (CRUD or intake).
 *
 * v1.4.40 W-RSC — the dashboard's aggregate compliance chart now
 * rides the factory under `dashboardMedicationCompliance`. The prefix
 * `["dashboard-medication-compliance"]` lands in the bundle so an
 * intake POST refreshes the chart immediately rather than waiting for
 * `staleTime` (audit L4).
 *
 * v1.5.5 D-3 §10 invariant 20 (was C-E2-1 / H-cluster-G) — the
 * per-medication inline compliance chart used to mount under
 * `queryKeys.medicationComplianceChart(medicationId)` which expands to
 * `["compliance-chart-inline", id]`. The prefix `["compliance-chart-inline"]`
 * lands in the bundle so every detail-page mutation (today's-dose,
 * Pausieren, end, purge, edit) evicts the inline compliance tile in
 * one tick. The TanStack hierarchical-prefix semantics catch every
 * per-medication slot under that prefix.
 *
 * `queryKeys.medicationDetail(id)` rides under the
 * `["medications"]` prefix already so a single medication invalidation
 * also evicts its detail-page read.
 */
export const medicationDependentKeys = [
  queryKeys.medications(),
  queryKeys.analytics(),
  queryKeys.insightsRoot(),
  queryKeys.insightsTargets(),
  queryKeys.gamificationAchievements(),
  ["dashboard-medication-compliance"] as const,
  ["compliance-chart-inline"] as const,
];

/**
 * Keys invalidated when cycle data changes (a day-log capture, a period
 * boundary, a day-log delete). The `["cycle"]` prefix catches the calendar
 * windows, the history stats, and the profile read in one tick so the
 * calendar/wheel and predictions panel never read stale rows after a quick
 * log. `insightsRoot()` rides along because phase-correlation cards depend
 * on the same rows.
 */
export const cycleDependentKeys = [queryKeys.cycle(), queryKeys.insightsRoot()];

/**
 * Invalidate every key in the bundle in parallel. Use this from mutation
 * `onSuccess` handlers so the call site stays a one-liner instead of repeating
 * `Promise.all(keys.map(...))` everywhere.
 *
 * Uses `allSettled` so one transient network failure doesn't abort subsequent
 * invalidations (cache would otherwise be left half-stale) and so the `void
 * invalidateKeys(...)` fire-and-forget pattern in delete handlers never
 * surfaces an unhandled rejection.
 */
export function invalidateKeys(
  queryClient: QueryClient,
  keys: readonly QueryKey[],
): Promise<PromiseSettledResult<unknown>[]> {
  return Promise.allSettled(
    keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  );
}
