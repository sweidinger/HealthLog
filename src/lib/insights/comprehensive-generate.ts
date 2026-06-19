/**
 * v1.7.0 W6 — shared comprehensive-insight generator.
 *
 * The on-demand `POST /api/insights/generate` route and the nightly
 * `insight-pregenerate` cron both need to run the same pipeline:
 * resolve the provider chain → extract + compact features → build the
 * strict prompt → run the completion with fallback → parse + cache the
 * result. This module is that single source of truth so the briefing
 * the cron pre-generates is byte-identical to what an on-demand
 * regenerate would have produced.
 *
 * The route keeps its request-specific concerns (rate-limit gate,
 * locale resolution from the request, audit-with-IP). The cron supplies
 * its own budget gate (a per-user rate-limit bucket so a nightly
 * fan-out across every user can never blow the LLM budget) before
 * calling `generateComprehensiveInsight`.
 *
 * NO synchronous request lifecycle: the cron path runs entirely on
 * pg-boss, never inside an HTTP handler.
 */
import { prisma } from "@/lib/db";
import {
  extractFeatures,
  FeaturesPayloadTooLargeError,
} from "@/lib/insights/features";
import { applyInsightsExcludeFilter } from "@/lib/insights/exclude-filter";
import { compactSections } from "@/lib/ai/prompts/compact-sections";
import {
  detectGlp1Plateau,
  buildGlp1PlateauPrompt,
} from "@/lib/insights/glp1-plateau";
import {
  buildUserPrompt,
  type ComparisonSnapshot,
} from "@/lib/ai/prompts/insight-system-prompt";
import { buildSystemPromptWithReferences } from "@/lib/ai/prompts/insight-generator";
import {
  buildAboutMeInsightBlock,
  getSelfContextTextForUser,
} from "@/lib/ai/coach/about-me";
import { metricsFromPresentSections } from "@/lib/ai/medical-references";
import { summarize, type DataPoint } from "@/lib/analytics/trends";
import {
  reconstructSleepNights,
  type SleepStageRow,
} from "@/lib/analytics/sleep-night";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import {
  resolveDashboardLayout,
  type ComparisonBaseline,
} from "@/lib/dashboard-layout";
import type { MeasurementType } from "@/generated/prisma/client";
import { insightResultSchema, type InsightResult } from "@/lib/ai/types";
import { resolveProvider, resolveProviderChain } from "@/lib/ai/provider";
import {
  AllProvidersFailedError,
  runRawCompletionWithFallback,
} from "@/lib/ai/provider-runner";
import {
  chainRequiresServerManagedConsent,
  hasActiveConsentForSurface,
} from "@/lib/ai/consent-guard";
import { invalidateUserInsights } from "@/lib/cache/invalidate";
import {
  enqueueStatusGeneration,
  type InsightStatusScope,
} from "@/lib/jobs/insight-status-generate-shared";
import { normalizeLocale, stripJsonFences } from "@/lib/insights/status-shared";
import { isTimeoutStub, statusCacheAction } from "@/lib/insights/status-cache";
import { hashInsightSnapshot } from "@/lib/insights/snapshot-hash";
import {
  metricIdForMeasurementType,
  metricStatusScope,
} from "@/lib/insights/metric-status-registry";
import { annotate } from "@/lib/logging/context";
import { AI_BUDGETS } from "@/lib/ai/ai-budgets";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Minimum gap between a scope's last cached (re)generation and the next
 * ingest-driven re-enqueue. A scope whose cached assessment was
 * (re)generated within this window is left intact on a fresh measurement
 * ingest — not re-enqueued.
 *
 * A constantly-syncing client (Apple Health drips batches every few
 * minutes) used to delete + re-enqueue every dirtied scope on every batch,
 * and because each delete dropped the cache row the per-(user,scope,locale)
 * enqueue singleton (120 s) could not coalesce across batches that arrive
 * minutes apart — so STEPS / general / a metric card regenerated several
 * times an hour and the assessment felt "regenerated on every visit". This
 * window coalesces the storm: a genuinely stale scope (no fresh assessment)
 * still refreshes immediately, but a scope refreshed inside the window is
 * skipped, so a fresh assessment survives the day's sync drip.
 *
 * v1.16.8 — first widened from 30 min to 6 h to bound provider spend, but
 * a 6 h wall meant same-day data was not narrated same-day: the nightly
 * warm at 04:30 restarted the window, so a notable 08:00 reading never
 * re-enqueued its scopes and the card showed the pre-reading text until
 * the next nightly tick. The window is now a ONE-HOUR minimum gap, and
 * the budget role the 6 h wall carried moves to the worker's content-hash
 * gate: every ingest that lands past the gap re-enqueues the dirtied
 * scopes, the worker's forced run re-gathers the snapshot, and the gate
 * (`refreshUnchangedStatusInsight`) turns an unchanged snapshot into a
 * timestamp refresh with zero provider cost. So this clock only bounds
 * the SQL-gather frequency — at most one worker run per scope per hour
 * under a constant sync drip — while provider spend tracks actual data
 * change, which is what the gate exists to meter. Comparing the hash
 * inline at invalidation time was rejected: it would run the full
 * per-scope data gather inside the ingest path, which is exactly the
 * work the queue exists to keep off that path.
 */
const INGEST_INVALIDATE_MIN_GAP_MS = 60 * 60 * 1000;

const MAX_DOWNGRADE_TOKENS: ReadonlyArray<string> = [
  "anthropometrics",
  "medications",
  "compliance",
  "sleep",
  "steps",
  "hrv",
  "resting_hr",
];

export type GenerateOutcome =
  | { status: "cached" }
  | { status: "generated"; providerType: string }
  /**
   * v1.16.8 — the content-hash gate found the compacted feature snapshot
   * unchanged since the cached text was generated. No provider call was
   * made; only `insightsCachedAt` was refreshed so the freshness windows
   * (GET read, nightly discovery) treat the cache as current.
   */
  | { status: "unchanged" }
  /**
   * v1.18.7 — the snapshot was unchanged (findings byte-stable) but the
   * daily-briefing PARAGRAPH was re-rolled at a higher, seedless
   * temperature for phrasing variety. At most one re-roll per calendar day.
   */
  | { status: "rerolled"; providerType: string }
  | { status: "skipped"; reason: "no-provider" | "no-consent" }
  | { status: "failed"; reason: string };

/** Higher, seedless temperature for the daily-briefing phrasing re-roll. */
const BRIEFING_REROLL_TEMPERATURE = 0.6;

/** UTC YYYY-MM-DD calendar-day key gating the once-per-day briefing re-roll. */
function buildRerollDateKey(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Re-roll ONLY the daily-briefing paragraph on a hash-unchanged hit.
 *
 * Runs the same comprehensive prompt at a higher, seedless temperature, then
 * keeps the cached payload verbatim and swaps in just the freshly-generated
 * `dailyBriefing.paragraph`. So the structured findings stay byte-stable
 * (reference assessments, monotony is fine) while the prose the user reads at
 * the top of /insights varies day-over-day. Returns null on any miss (no
 * provider success, invalid JSON, no cached/new paragraph) so the caller
 * falls back to the plain timestamp refresh.
 */
async function rerollBriefingParagraph(args: {
  userId: string;
  chain: Awaited<ReturnType<typeof resolveProviderChain>>;
  systemPrompt: string;
  userPrompt: string;
  cachedText: string;
  locale: "de" | "en";
}): Promise<{ text: string; providerType: string } | null> {
  let cached: Record<string, unknown>;
  try {
    cached = JSON.parse(args.cachedText) as Record<string, unknown>;
  } catch {
    return null;
  }
  const cachedBriefing = cached.dailyBriefing;
  // Nothing to re-roll when the cached payload carries no briefing paragraph.
  if (
    cachedBriefing === null ||
    typeof cachedBriefing !== "object" ||
    typeof (cachedBriefing as { paragraph?: unknown }).paragraph !== "string"
  ) {
    return null;
  }

  let result;
  let providerType: string;
  try {
    const fallback = await runRawCompletionWithFallback({
      userId: args.userId,
      providers: args.chain,
      params: {
        systemPrompt: args.systemPrompt,
        userPrompt: args.userPrompt,
        // Seedless on purpose: the seed would pin the same phrasing, which is
        // exactly what we are varying. Higher temperature for prose variety.
        temperature: BRIEFING_REROLL_TEMPERATURE,
        maxTokens: AI_BUDGETS.comprehensive.maxTokens,
        responseFormat: "json",
      },
    });
    result = fallback.result;
    providerType = fallback.workingProvider.providerType;
  } catch {
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripJsonFences(result.content)) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
  const freshBriefing = parsed.dailyBriefing;
  const freshParagraph =
    freshBriefing && typeof freshBriefing === "object"
      ? (freshBriefing as { paragraph?: unknown }).paragraph
      : undefined;
  if (typeof freshParagraph !== "string" || freshParagraph.trim().length === 0) {
    return null;
  }

  // Keep the cached payload verbatim; swap in only the fresh paragraph.
  const mergedBriefing = {
    ...(cachedBriefing as Record<string, unknown>),
    paragraph: freshParagraph,
  };
  const merged = { ...cached, dailyBriefing: mergedBriefing };
  return { text: JSON.stringify(merged), providerType };
}

/**
 * Comparison-snapshot builder — shared with the on-demand route. Returns
 * null when the user's comparison toggle is off (most users), so the
 * prompt builder skips the context block entirely.
 */
export async function buildComparisonSnapshotForUser(
  userId: string,
): Promise<ComparisonSnapshot | null> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { dashboardWidgetsJson: true },
  });
  const layout = resolveDashboardLayout(row?.dashboardWidgetsJson);
  const baseline: ComparisonBaseline = layout.comparisonBaseline ?? "none";
  if (baseline === "none") return null;

  const typeToSnapshotKey: Record<string, string> = {
    WEIGHT: "weight",
    BLOOD_PRESSURE_SYS: "bloodPressureSys",
    BLOOD_PRESSURE_DIA: "bloodPressureDia",
    PULSE: "pulse",
    BODY_FAT: "bodyFat",
    SLEEP_DURATION: "sleep",
    ACTIVITY_STEPS: "steps",
  };
  const typeUnits: Record<string, string> = {
    WEIGHT: "kg",
    BLOOD_PRESSURE_SYS: "mmHg",
    BLOOD_PRESSURE_DIA: "mmHg",
    PULSE: "bpm",
    BODY_FAT: "%",
    SLEEP_DURATION: "h",
    ACTIVITY_STEPS: "",
  };
  const types = Object.keys(typeToSnapshotKey) as MeasurementType[];
  const rows = await Promise.all(
    types.map(async (type) => {
      // SLEEP_DURATION is stored ONE ROW PER STAGE per night; summarising the
      // raw stage rows mislabels a per-stage average as a night total (and
      // double-counts a bare ASLEEP aggregate against its granular twin). Route
      // the comparison through the per-night dedup reconstruction so the
      // current/baseline averages are per-night TIME-ASLEEP totals in minutes.
      let dataPoints: DataPoint[];
      if (type === "SLEEP_DURATION") {
        const [sleepRows, sleepTz, sleepPriority] = await Promise.all([
          prisma.measurement.findMany({
            where: { userId, type, deletedAt: null },
            orderBy: { measuredAt: "asc" },
            select: {
              measuredAt: true,
              value: true,
              sleepStage: true,
              source: true,
              // Writer-level collapse: two HealthKit apps behind one
              // source (watch stages vs phone in-bed) must not blend.
              deviceType: true,
            },
          }),
          resolveUserTimezone(userId),
          loadUserSourcePriority(userId),
        ]);
        dataPoints = reconstructSleepNights(
          sleepRows as SleepStageRow[],
          sleepTz,
          sleepPriority,
        )
          .filter((n) => n.asleepMinutes > 0)
          .map((n) => ({ date: n.measuredAt, value: n.asleepMinutes }));
      } else {
        const measurements = await prisma.measurement.findMany({
          where: { userId, type, deletedAt: null },
          orderBy: { measuredAt: "asc" },
          select: { measuredAt: true, value: true },
        });
        dataPoints = measurements.map(
          (m): DataPoint => ({ date: m.measuredAt, value: m.value }),
        );
      }
      const summary = summarize(dataPoints);
      const baselineAvg =
        baseline === "lastMonth"
          ? (summary.avg30LastMonth ?? null)
          : (summary.avg30LastYear ?? null);
      const currentAvg = summary.avg30 ?? null;
      const delta =
        currentAvg !== null && baselineAvg !== null
          ? Math.round((currentAvg - baselineAvg) * 100) / 100
          : null;
      const deltaPercent =
        delta !== null && baselineAvg !== null && baselineAvg !== 0
          ? Math.round((delta / Math.abs(baselineAvg)) * 100 * 10) / 10
          : null;
      return {
        type: typeToSnapshotKey[type] ?? type,
        currentAvg,
        baselineAvg,
        delta,
        deltaPercent,
        unit: typeUnits[type] ?? "",
      };
    }),
  );

  const metrics = rows.filter(
    (row) => row.currentAvg !== null || row.baselineAvg !== null,
  );

  return { baseline, metrics };
}

/**
 * The seven per-metric assessment scopes. Each generator persists its
 * cached text under `insights.<scope>-status.<locale>`; the nightly warm
 * pass refreshes them through each generator's content-hash gate, and the
 * targeted invalidator below re-enqueues only the scopes a fresh
 * measurement of a given type actually dirties.
 */
export const PER_STATUS_SCOPES = [
  "blood-pressure",
  "pulse",
  "weight",
  "bmi",
  "mood",
  "medication-compliance",
  "general",
] as const;

export type PerStatusScope = (typeof PER_STATUS_SCOPES)[number];

/**
 * Map a measurement type to the assessment scopes a fresh reading of it
 * dirties. `general` is the catch-all overview, so every measurement
 * type touches it. BMI rides on WEIGHT (it is weight ÷ height²), so a
 * new weight reading invalidates both the weight and the BMI card.
 */
function statusScopesForMeasurementType(
  type: MeasurementType,
): PerStatusScope[] {
  switch (type) {
    case "WEIGHT":
      return ["weight", "bmi", "general"];
    case "BLOOD_PRESSURE_SYS":
    case "BLOOD_PRESSURE_DIA":
      return ["blood-pressure", "general"];
    case "PULSE":
    case "RESTING_HEART_RATE":
      return ["pulse", "general"];
    default:
      // Every other tracked metric (body composition, sleep, steps,
      // glucose, …) still feeds the general overview assessment.
      return ["general"];
  }
}

/**
 * Re-warm the cached per-metric assessments that a batch of fresh
 * measurements dirties, so the next mount (or the next nightly warm
 * pass) reflects the new data instead of serving the pre-measurement
 * text for the rest of the day.
 *
 * Fire-and-forget from the measurement ingest path — idempotent and
 * never a blocker on the user's write. v1.16.8 — the invalidator no
 * longer DELETES the cache rows: the worker regenerates each enqueued
 * scope with `force: true`, and the generator's content-hash gate
 * decides whether the data actually changed. Keeping the row intact
 * preserves the stale-while-revalidate read AND lets the gate skip the
 * LLM entirely when the dirtying batch turned out to be a re-sync of
 * known data.
 */
export async function invalidateStatusInsightsForTypes(
  userId: string,
  types: Iterable<MeasurementType>,
): Promise<void> {
  // One ordered set of every scope the batch dirties. The seven specialised
  // scopes are bare slugs (`weight`, `general`, …); the generic HealthKit
  // cards (v1.8.7.1) carry a `metric:<ID>` prefix. Both share the cache-key
  // shape `insights.<scope>-status.<locale>`, so a single set covers the
  // eviction + the debounce filter + the enqueue uniformly. Only registered,
  // data-bearing types contribute a generic scope; the seven specialised
  // metrics and any unregistered type resolve to null and are skipped, so
  // the constant sync cannot fan out to unwanted scopes.
  const scopes = new Set<InsightStatusScope>();
  for (const type of types) {
    for (const scope of statusScopesForMeasurementType(type)) {
      scopes.add(scope);
    }
    const metricId = metricIdForMeasurementType(type);
    if (metricId) {
      scopes.add(metricStatusScope(metricId));
    }
  }
  if (scopes.size === 0) return;

  // v1.8.7 — regenerate only the user's resolved locale, matching the
  // read-path (every `*-status` GET serves `normalizeLocale(user.locale)`).
  // Warming both locales doubled provider spend on every sync, half of it
  // for a language the user never opens. A second locale a client actually
  // reads warms lazily through the read-path enqueue on its first miss.
  const localeRow = await prisma.user.findUnique({
    where: { id: userId },
    select: { locale: true },
  });
  const locale = normalizeLocale(localeRow?.locale);

  // v1.9.0 — debounce the ingest-invalidation storm. A constantly-syncing
  // client drips batches every few minutes; re-enqueuing every dirtied
  // scope on every batch regenerated the same card several times an hour
  // (the per-(user,scope,locale) enqueue singleton is only 120 s, so it
  // could not coalesce across batches arriving minutes apart). Skip any
  // scope whose cached assessment was (re)generated within the minimum
  // gap — leave its row intact and do NOT re-enqueue. A genuinely stale
  // or missing scope still refreshes immediately, so correctness holds;
  // only the redundant churn is removed. Past the gap the enqueue always
  // goes through — the worker's content-hash gate decides whether the
  // batch actually changed anything (see the constant's doc).
  const freshScopes = await findRecentlyWarmedScopes(userId, locale, scopes);
  const staleScopes = Array.from(scopes).filter(
    (scope) => !freshScopes.has(scope),
  );
  if (staleScopes.length === 0) {
    annotate({
      action: { name: "insights.status.invalidate.debounced" },
      meta: { skipped: scopes.size, refreshed: 0 },
    });
    return;
  }

  // v1.8.7 — regenerate-on-invalidate: enqueue a debounced regenerate for
  // each dirtied scope so the cache is re-warmed in the background. The
  // enqueue is coalesced per `(user, metric, locale)` via the queue's
  // `singletonKey` (120 s window); the debounce above is the second, wider
  // coalescing layer that survives across the sync drip. The cache row
  // stays in place (stale-while-revalidate keeps the previous assessment
  // visible) — the worker forces the generator, whose content-hash gate
  // skips the LLM when the batch did not actually change the snapshot.
  for (const scope of staleScopes) {
    void enqueueStatusGeneration({ userId, metric: scope, locale });
  }

  annotate({
    action: { name: "insights.status.invalidate.debounced" },
    meta: { skipped: freshScopes.size, refreshed: staleScopes.length },
  });
}

/**
 * v1.16.8 — enqueue a hash-gated refill of every assessment card one user
 * actually has: the seven specialised scopes plus the generic
 * `metric:<ID>` scope of every measurement type with live rows. The
 * worker regenerates each enqueued scope with `force: true`, so every
 * card skips its same-day cache read, re-gathers its snapshot, and lands
 * on the content-hash gate — a card whose data changed regenerates, an
 * unchanged card gets a free timestamp refresh.
 *
 * This is the manual-regenerate path's card story: the POST regenerate
 * used to blanket-evict every per-status row, which deleted the hash
 * baselines and force-paid ~45 regenerations per click. Enqueuing through
 * the gate keeps the baseline rows intact, so a user who noticed a stale
 * card gets exactly the changed cards re-narrated — and nothing else.
 * Deliberately NOT routed through the ingest debounce: an explicit
 * regenerate is a user action, already bounded by the route's hourly
 * rate limit and the queue's per-(user,scope,locale) singleton.
 *
 * Returns the number of scopes enqueued (best-effort — the generic-scope
 * discovery read failing still refills the seven specialised cards).
 */
export async function enqueueStatusRefillForUser(
  userId: string,
  locale: "de" | "en",
): Promise<number> {
  const scopes = new Set<InsightStatusScope>(PER_STATUS_SCOPES);
  try {
    const rows = await prisma.measurement.findMany({
      where: { userId, deletedAt: null },
      distinct: ["type"],
      select: { type: true },
    });
    for (const row of rows) {
      const metricId = metricIdForMeasurementType(row.type);
      if (metricId) scopes.add(metricStatusScope(metricId));
    }
  } catch {
    // Discovery is best-effort; the specialised scopes still refill.
  }
  for (const scope of scopes) {
    void enqueueStatusGeneration({ userId, metric: scope, locale });
  }
  return scopes.size;
}

/**
 * v1.9.0 — return the subset of `scopes` whose cached assessment for
 * `locale` was generated within `INGEST_INVALIDATE_MIN_GAP_MS` and is a
 * real (non-stub) assessment. Those scopes are skipped by the ingest
 * invalidator so a fresh assessment survives the sync drip.
 *
 * One indexed read per user (a single `findMany` over this user's recent
 * status-cache rows, newest-first) answers it for every candidate scope at
 * once — cheaper than a per-scope probe and bounded by `take`. A timeout
 * stub never counts as fresh (it carries no real assessment), so a scope
 * that recently stalled still gets a retry enqueued.
 */
async function findRecentlyWarmedScopes(
  userId: string,
  locale: "de" | "en",
  scopes: ReadonlySet<InsightStatusScope>,
): Promise<Set<InsightStatusScope>> {
  const cutoff = new Date(Date.now() - INGEST_INVALIDATE_MIN_GAP_MS);
  // Match exactly the cache actions for the candidate scopes in this locale.
  const candidateActions = Array.from(scopes, (scope) =>
    statusCacheAction(scope, locale),
  );
  const actionToScope = new Map<string, InsightStatusScope>();
  for (const scope of scopes) {
    actionToScope.set(statusCacheAction(scope, locale), scope);
  }

  const rows = await prisma.auditLog.findMany({
    where: {
      userId,
      action: { in: candidateActions },
      createdAt: { gte: cutoff },
    },
    orderBy: { createdAt: "desc" },
    select: { action: true, details: true },
  });

  const fresh = new Set<InsightStatusScope>();
  for (const row of rows) {
    const scope = actionToScope.get(row.action);
    if (!scope || fresh.has(scope)) continue;
    if (!row.details) continue;
    try {
      const parsed = JSON.parse(row.details) as {
        model?: string;
        timeout?: boolean;
        text?: string;
      };
      // A stub is not a real assessment — let a stalled scope retry.
      if (isTimeoutStub(parsed)) continue;
      if (typeof parsed.text !== "string" || parsed.text.trim().length === 0) {
        continue;
      }
      fresh.add(scope);
    } catch {
      // Malformed payload — treat as not-fresh so the scope refreshes.
      continue;
    }
  }
  return fresh;
}

interface GenerateOptions {
  /** Resolved UI locale for the prompt + cache row. */
  locale: "de" | "en";
  /** Skip the 24 h cache short-circuit and force a fresh generation. */
  force?: boolean;
  /**
   * v1.9.0 — abort the generation when the caller has given up on it.
   *
   * The on-demand `forceWarmUser` path bounds the comprehensive step with a
   * timeout and then proceeds to warm the per-status caches itself. Without
   * this signal a comprehensive that resolves AFTER the timeout would still
   * write a cache row + timestamp the caller no longer expects. The signal
   * lets the caller cut the generation off before the cache write.
   */
  signal?: AbortSignal;
}

/**
 * Resolve + cache the comprehensive insight for one user. Pure
 * pipeline; no rate-limit / audit / request concerns. Returns a typed
 * outcome the caller (route or cron) can log + branch on.
 *
 * On a 24 h cache hit (and `!force`) returns `{ status: "cached" }`
 * without touching the provider chain. On a provider miss returns
 * `{ status: "skipped", reason: "no-provider" }`. Provider failures
 * map to `{ status: "failed" }` rather than throwing so a cron batch
 * loop continues to the next user.
 */
export async function generateComprehensiveInsight(
  userId: string,
  options: GenerateOptions,
): Promise<GenerateOutcome> {
  const { locale } = options;
  const force = options.force === true;
  const signal = options.signal;

  const dbUser = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      insightsPrivacyMode: true,
      insightsCachedAt: true,
      insightsCachedText: true,
      insightsExcludeMetrics: true,
      insightsSnapshotHash: true,
      insightsBriefingRerollDate: true,
      // The comparison-baseline setting joins the snapshot fingerprint
      // (see the hash construction below), so it must be readable BEFORE
      // the gate — the comparison snapshot itself is only built after.
      dashboardWidgetsJson: true,
    },
  });

  if (
    !force &&
    dbUser?.insightsCachedAt &&
    dbUser.insightsCachedText &&
    Date.now() - dbUser.insightsCachedAt.getTime() < CACHE_TTL_MS
  ) {
    return { status: "cached" };
  }

  const chain = await resolveProviderChain(userId);
  if (chain.length === 0) {
    const legacy = await resolveProvider(userId);
    if (legacy.type === "none") {
      return { status: "skipped", reason: "no-provider" };
    }
    chain.push({ providerType: "admin-openai", instance: legacy });
  }

  // v1.12.1 — consent gate before any server-managed external egress. This
  // pipeline runs off-request (nightly cron + on-demand force-warm), so a
  // missing receipt is a typed `skipped` outcome rather than a throw — the
  // cron batch continues to the next user. BYOK / local / ChatGPT-OAuth
  // chains never trip the check.
  if (
    chainRequiresServerManagedConsent(chain) &&
    !(await hasActiveConsentForSurface(userId, "insights"))
  ) {
    return { status: "skipped", reason: "no-consent" };
  }

  const includeRaw = dbUser?.insightsPrivacyMode === "raw";
  let features: Awaited<ReturnType<typeof extractFeatures>>;
  try {
    features = await extractFeatures(userId, includeRaw);
  } catch (err) {
    if (err instanceof FeaturesPayloadTooLargeError) {
      try {
        features = await extractFeatures(userId, false);
      } catch (retryErr) {
        if (retryErr instanceof FeaturesPayloadTooLargeError) {
          try {
            const aggregated = await extractFeatures(userId, false);
            features = applyInsightsExcludeFilter(
              aggregated,
              MAX_DOWNGRADE_TOKENS,
            );
          } catch {
            return { status: "failed", reason: "payload-too-large" };
          }
        } else {
          return { status: "failed", reason: "features-error" };
        }
      }
    } else {
      return { status: "failed", reason: "features-error" };
    }
  }

  const excludeList = dbUser?.insightsExcludeMetrics ?? [];
  features = applyInsightsExcludeFilter(features, excludeList);
  const compactFeatures = compactSections(
    features as unknown as Record<string, unknown>,
  );
  const featuresJson = JSON.stringify(compactFeatures, null, 2);

  // v1.16.8 — content-hash gate. When the compacted feature snapshot is
  // byte-equivalent (modulo clock-relative offsets, see snapshot-hash.ts)
  // to the one the cached text was generated from, nothing the prompt
  // sees has changed — refresh the cache timestamp and skip the provider
  // call. This runs on the forced paths too (nightly tick, on-demand
  // warm), which is exactly where the same-data regeneration waste lived.
  //
  // The user-authored "about me" self-description joins the fingerprint:
  // it is the one prompt input that can change with NO data change (the
  // Coach remember action, a Settings → AI edit), and excluding it would
  // pin the briefing to the pre-edit self-context until a measurement
  // happens to move. The plateau block stays out — it derives from the
  // same measurement rows the feature snapshot already fingerprints.
  // Fetched once here and reused for the prompt below.
  //
  // Two more prompt inputs that can flip with no data change join the
  // composite (the shape MUST stay identical to the POST route's hash
  // write in `generate/route.ts`, or every nightly force-regenerates):
  //   - `comparisonBaseline`: the user's comparison toggle. Switching it
  //     adds/removes the prior-period context block, so the cached text
  //     no longer matches what the prompt would produce.
  //   - `generationLocale`: the locale the briefing renders in. Hashing
  //     it means a locale switch regenerates ONCE — intended, the
  //     briefing language must follow the reader; afterwards the new
  //     locale's hash is the stored baseline and the gate holds again.
  //     The key is named `generationLocale` (not `locale`) on purpose:
  //     the canonicaliser in `snapshot-hash.ts` strips `locale` keys as
  //     volatile, which is right for the per-locale-keyed status caches
  //     but would silently drop the field from THIS composite.
  const aboutMe = await getSelfContextTextForUser(userId, locale);
  const comparisonBaseline: ComparisonBaseline =
    resolveDashboardLayout(dbUser?.dashboardWidgetsJson).comparisonBaseline ??
    "none";
  const snapshotHash = hashInsightSnapshot({
    features: compactFeatures,
    aboutMe: aboutMe ?? null,
    comparisonBaseline,
    generationLocale: locale,
  });
  // v1.12.7 (B5) — the curated SOURCES block for the metrics present, shared
  // by both the full generation below and the unchanged-data re-roll.
  const referenceMetrics = metricsFromPresentSections({
    bloodPressure: features.bloodPressure != null,
    weight: features.weight != null,
    pulse: features.pulse != null,
    mood: features.mood != null,
    medication: (features.medications?.length ?? 0) > 0,
  });

  const comparisonSnapshot = await buildComparisonSnapshotForUser(userId);
  const plateauContext = await detectGlp1Plateau(userId);
  let userPrompt = buildUserPrompt(
    featuresJson,
    dbUser?.insightsPrivacyMode ?? "aggregated",
    locale,
    comparisonSnapshot ?? undefined,
  );
  if (plateauContext) {
    userPrompt += buildGlp1PlateauPrompt(plateauContext, locale);
  }
  if (aboutMe) {
    userPrompt += buildAboutMeInsightBlock(aboutMe, locale);
  }
  const systemPrompt = buildSystemPromptWithReferences(locale, referenceMetrics);

  if (
    dbUser?.insightsCachedText &&
    dbUser.insightsSnapshotHash === snapshotHash
  ) {
    // v1.18.7 (MEDIUM-3) — findings are byte-stable, but re-roll the daily-
    // briefing PARAGRAPH once per calendar day so the prose reads fresh
    // day-over-day. Gated on `insightsBriefingRerollDate` so it costs at
    // most one extra call/day; the higher, seedless temperature varies the
    // phrasing while the structured findings are preserved verbatim from the
    // cached payload. Any miss falls through to the plain timestamp refresh.
    const todayKey = buildRerollDateKey();
    if (dbUser.insightsBriefingRerollDate !== todayKey) {
      const rerolled = await rerollBriefingParagraph({
        userId,
        chain,
        systemPrompt,
        userPrompt,
        cachedText: dbUser.insightsCachedText,
        locale,
      });
      if (rerolled) {
        await prisma.user.update({
          where: { id: userId },
          data: {
            insightsCachedAt: new Date(),
            insightsCachedText: rerolled.text,
            insightsBriefingRerollDate: todayKey,
          },
        });
        invalidateUserInsights(userId);
        annotate({
          action: { name: "insights.generate.briefing_rerolled" },
          meta: { locale, provider: rerolled.providerType },
        });
        return { status: "rerolled", providerType: rerolled.providerType };
      }
      // A re-roll miss still stamps the day so a persistently failing
      // provider cannot be re-driven on every page-open; the next day retries.
      await prisma.user.update({
        where: { id: userId },
        data: {
          insightsCachedAt: new Date(),
          insightsBriefingRerollDate: todayKey,
        },
      });
      annotate({
        action: { name: "insights.generate.skipped_unchanged" },
        meta: { locale, rerollAttempted: true },
      });
      return { status: "unchanged" };
    }
    await prisma.user.update({
      where: { id: userId },
      data: { insightsCachedAt: new Date() },
    });
    annotate({
      action: { name: "insights.generate.skipped_unchanged" },
      meta: { locale },
    });
    return { status: "unchanged" };
  }

  let result;
  let workingProviderType: string;
  try {
    const fallback = await runRawCompletionWithFallback({
      userId,
      providers: chain,
      params: {
        systemPrompt,
        userPrompt,
        temperature: AI_BUDGETS.comprehensive.temperature,
        maxTokens: AI_BUDGETS.comprehensive.maxTokens,
        // v1.18.7 — structured surface: opt the non-OpenAI chains into their
        // strongest JSON mode (Ollama `format`, Anthropic `{` prefill) so a
        // first-pass JSON miss is rarer; stripJsonFences stays the net.
        responseFormat: "json",
      },
    });
    result = fallback.result;
    workingProviderType = fallback.workingProvider.providerType;
  } catch (e) {
    if (e instanceof AllProvidersFailedError) {
      return { status: "failed", reason: "all-providers-failed" };
    }
    return { status: "failed", reason: "provider-error" };
  }

  let insights: InsightResult | Record<string, unknown>;
  try {
    // Anthropic + local have no native JSON mode, so a ```json-fenced or
    // sentence-prefixed reply would otherwise fail the whole generation.
    // Strip the fence before parsing; clean JSON passes through unchanged.
    const parsed = JSON.parse(stripJsonFences(result.content));
    const validated = insightResultSchema.safeParse(parsed);
    insights = validated.success ? validated.data : parsed;
  } catch {
    return { status: "failed", reason: "invalid-json" };
  }

  // v1.9.0 — the caller abandoned this generation (its bounded timeout
  // fired and it has moved on to warm the per-status caches itself). Bail
  // out before the cache write so a late-resolving comprehensive cannot
  // stamp a timestamp/text the caller no longer expects. The provider call
  // already cost what it cost; what we must NOT do now is touch the cache.
  if (signal?.aborted) {
    return { status: "failed", reason: "aborted" };
  }

  await prisma.user.update({
    where: { id: userId },
    data: {
      insightsCachedAt: new Date(),
      insightsCachedText: JSON.stringify(insights),
      insightsSnapshotHash: snapshotHash,
    },
  });
  // v1.16.8 — no blanket per-status eviction here any more. The cards
  // track their own data through the ingest invalidator and their own
  // content-hash gates; a fresh comprehensive briefing does not change
  // what a per-metric card should say, and the old sweep was the reason
  // every warm had to regenerate ~45 cards across both locales.
  invalidateUserInsights(userId);

  return { status: "generated", providerType: workingProviderType };
}
