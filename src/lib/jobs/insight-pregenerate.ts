/**
 * v1.7.0 W6 — nightly insight pre-generation cron.
 *
 * Closes the gap the R-firstpaint audit surfaced: before this cron,
 * every daily briefing was generated lazily on the first `/insights`
 * mount after the 24 h cache expired, blocking that request on the
 * provider chain. This cron pre-generates the comprehensive insight
 * (which carries the `dailyBriefing` block) overnight so the mount-time
 * advisor POST is always a pure cache read, and the v1.7.0 dashboard
 * snapshot embeds a `briefingState: "ready"` block instead of
 * `"preparing"`.
 *
 * v1.8.0 — warm the per-metric assessment caches too. The comprehensive
 * generator evicts the seven `insights.<scope>-status.<locale>` caches
 * as part of its write (so a stale comprehensive insight can never leave
 * a stale per-metric card behind) but does NOT re-fill them. Before this,
 * the morning after the cron ran the per-metric status caches were
 * empty, so the first `/insights` mount still ran one live status
 * generation per card. After a successful comprehensive generation this
 * cron now forces the seven `*StatusForUser` generators so their caches
 * are warm, not empty, by the user's first visit.
 *
 * Runs once nightly at 04:30 Europe/Berlin — inside the existing
 * 03:xx–04:xx maintenance window, after the feedback aggregator (04:00)
 * and the cumulative drain (03:30) so the late-night CPU profile stays
 * coherent.
 *
 * Budget gate (R-firstpaint §6 tertiary risk): a nightly fan-out across
 * every user could spike provider cost. Two layers guard it:
 *   1. A per-user rate-limit bucket (`insight-pregenerate:${userId}`,
 *      1 generation / 20 h) so the cron can never double-generate a
 *      user the on-demand route already refreshed today.
 *   2. A hard per-run batch cap (`PREGENERATE_BATCH_CAP`) so a single
 *      tick processes at most N users; the discovery query is ordered
 *      oldest-cache-first so the staleest users are served first and
 *      the long tail catches up over successive nights.
 *
 * The discovery query selects only users that are worth a generation:
 * coach surface enabled (`disableCoach = false`) AND a stale-or-missing
 * cache (`insightsCachedAt IS NULL OR < now - PREGENERATE_STALE_MS`,
 * see the constant for why that window is one hour). Whether the user
 * has a configured provider is confirmed inside
 * `generateComprehensiveInsight` (returns `skipped: no-provider`), so a
 * provider-less account costs one cheap chain-resolve and no LLM call.
 *
 * Recurring pg-boss task — never runs inside an HTTP request and never
 * shells out to `tsx` (CLAUDE.md DO-NOTs).
 */
import pLimit from "p-limit";

import type { PrismaClient } from "@/generated/prisma/client";
import { checkRateLimit } from "@/lib/rate-limit";
import { getAssistantFlags } from "@/lib/feature-flags";
import { annotate } from "@/lib/logging/context";
import {
  generateComprehensiveInsight,
  type GenerateOutcome,
} from "@/lib/insights/comprehensive-generate";
import { generateBloodPressureStatusForUser } from "@/lib/insights/blood-pressure-status";
import { generatePulseStatusForUser } from "@/lib/insights/pulse-status";
import { generateWeightStatusForUser } from "@/lib/insights/weight-status";
import { generateBmiStatusForUser } from "@/lib/insights/bmi-status";
import { generateMoodStatusForUser } from "@/lib/insights/mood-status";
import { generateMedicationComplianceStatusForUser } from "@/lib/insights/medication-compliance-status";
import { generateGeneralStatusForUser } from "@/lib/insights/general-status";
import { generateMetricStatus } from "@/lib/insights/metric-status";
import {
  METRIC_STATUS_IDS,
  getMetricStatusMeta,
  type MetricStatusMetricId,
} from "@/lib/insights/metric-status-registry";
import { withTimeout } from "@/lib/insights/with-timeout";
import {
  INSIGHT_PREGENERATE_QUEUE,
  enqueueForceWarm,
  type InsightPregeneratePayload,
} from "@/lib/jobs/insight-pregenerate-shared";

export {
  INSIGHT_PREGENERATE_QUEUE,
  enqueueForceWarm,
};
export type { InsightPregeneratePayload };

/**
 * 04:30 Europe/Berlin. Slots between the cumulative drain (03:30) and
 * the feedback aggregator (04:00) maintenance window's tail so the
 * LLM-bound pass doesn't contend with the SQL-bound nightly folds.
 */
export const INSIGHT_PREGENERATE_CRON = "30 4 * * *";

/** Stale-cache threshold for the nightly discovery pass.
 *
 * The cron runs every 24 h and the advisor cache lives 24 h — so ANY
 * cache not written within the last hour will expire before the next
 * nightly tick, i.e. at some point during the user's day. The previous
 * 20 h threshold structurally excluded every evening visitor: a visit
 * at ~19:50 stamps `insightsCachedAt`, the 04:30 run sees a ~9 h-old
 * cache and skips, and the cache then expires at ~19:50 the next day —
 * exactly when the user returns. That recreated the on-visit warm storm
 * (comprehensive feature extraction + the full per-card warm pass in
 * the request-serving process) every single evening, which is what the
 * nightly pass exists to prevent. One hour keeps the only sensible
 * skip: a cache the on-demand path generated minutes before the tick.
 */
export const PREGENERATE_STALE_MS = 60 * 60 * 1000;

/** Per-run cap on the number of users a single tick generates for. */
export const PREGENERATE_BATCH_CAP = 200;

/** Per-user budget bucket window — one pre-generation per 20 h. */
const PREGENERATE_BUDGET_WINDOW_MS = 20 * 60 * 60 * 1000;

/**
 * Concurrency for the per-user warm pass. The seven `*StatusForUser`
 * generators are independent (each writes its own cache row), so they run
 * a few at a time rather than strictly serially — a daily-weigher with
 * every card configured was paying ~7× one LLM round-trip per user back
 * to back. Capped low (3) so the warm pass cannot saturate the Prisma
 * pool or fan out an unbounded number of concurrent provider calls; the
 * per-user budget gate above still bounds total cost per night.
 */
const WARM_PASS_CONCURRENCY = 3;

/**
 * Bounded budget for one comprehensive generation inside a warm pass —
 * the forced single-user warm AND the nightly per-candidate loop. The
 * comprehensive insight is the single heaviest generation (full feature
 * extraction + a 1500-token completion) and a slow or stalled provider
 * could pin the whole warm for a minute-plus, after which the entire job
 * aborted with the per-status + generic-metric passes never run. Capping
 * it lets both paths abandon a slow comprehensive and still warm the
 * cheaper per-status (7) + generic-metric (~30) assessments, so the user's
 * cards are warm even when the briefing generation stalls. In the nightly
 * loop the cap also bounds head-of-line blocking: without it one stalled
 * provider pinned the whole batch behind a single candidate. Set a hair
 * below the queue's own retry horizon so a single tick stays bounded.
 */
const COMPREHENSIVE_WARM_TIMEOUT_MS = 45_000;

/** Per-user result of one forced full warm. */
export interface ForceWarmResult {
  /**
   * Outcome of the comprehensive-insight generation. `"timeout"` is
   * distinct from `"failed"`: the comprehensive step exceeded its own
   * bounded budget (see `COMPREHENSIVE_WARM_TIMEOUT_MS`) and was
   * abandoned so the per-status + generic-metric passes could still run.
   */
  comprehensive: GenerateOutcome["status"] | "timeout";
  /** Count of specialised per-status assessments written warm. */
  assessmentsWarmed: number;
  /** Count of generic per-HealthKit-metric assessments written warm. */
  metricAssessmentsWarmed: number;
}

export interface PregenerateRunResult {
  total: number;
  generated: number;
  cached: number;
  skipped: number;
  failed: number;
  budgetBlocked: number;
  /**
   * Count of per-metric assessment caches written warm across the whole
   * run. The comprehensive generator evicts the seven `*-status`
   * caches as part of its write (so a stale comprehensive insight can't
   * leave a stale per-metric card), but it does not re-fill them — so
   * without this warm pass the first morning visit after the cron runs
   * one live status generation per card. This counts the warm writes.
   */
  assessmentsWarmed: number;
  /**
   * v1.8.7.1 — count of generic per-HealthKit-metric assessment caches
   * written warm across the run (the ~30 metric pages, data-bearing
   * only). Tracked separately from `assessmentsWarmed` so the nightly
   * dashboard can see the generic-tier coverage independently of the
   * seven specialised cards.
   */
  metricAssessmentsWarmed: number;
}

/**
 * Signature for one per-metric status generator. The seven
 * `*StatusForUser` functions all share this shape: `(userId, { locale,
 * force }) => { hasProvider, text, cached, updatedAt }`. We only need to
 * know whether the call produced a fresh (non-cached, provider-backed)
 * assessment, so the warm-pass narrows to those two fields.
 */
type StatusGenerator = (
  userId: string,
  options: { locale: "de" | "en"; force?: boolean },
) => Promise<{ hasProvider: boolean; cached: boolean }>;

/**
 * The seven per-metric status generators the warm pass re-fills after
 * the comprehensive generator evicted them. Each writes its own
 * `insights.<scope>-status.<locale>` cache row on a fresh generation and
 * resolves the user's provider chain internally, so a provider-less
 * account costs one cheap chain-resolve and no LLM call (`hasProvider:
 * false`).
 */
const DEFAULT_STATUS_GENERATORS: ReadonlyArray<StatusGenerator> = [
  generateBloodPressureStatusForUser,
  generatePulseStatusForUser,
  generateWeightStatusForUser,
  generateBmiStatusForUser,
  generateMoodStatusForUser,
  generateMedicationComplianceStatusForUser,
  generateGeneralStatusForUser,
];

/**
 * Re-fill the per-metric assessment caches for one user, forcing a fresh
 * generation so the row the comprehensive generator just evicted is
 * written warm. Returns the count of fresh (provider-backed,
 * non-cached) assessments written. A generator that has no provider or
 * fails serves its fallback without persisting it, so it does not count
 * toward the warmed tally and never throws the batch loop off course.
 */
async function warmPerStatusCaches(
  userId: string,
  locales: ReadonlyArray<"de" | "en">,
  generators: ReadonlyArray<StatusGenerator>,
  // v1.16.1 — `force: false` is the refill-only mode the nightly fallback
  // warm uses: the per-status cache is keyed on today's dateKey, so a card
  // already generated today short-circuits to its cache row while a cold
  // card still generates. The eviction path (after a generated/cached
  // comprehensive) keeps `force: true` because the rows were just deleted.
  force = true,
): Promise<number> {
  const limit = pLimit(WARM_PASS_CONCURRENCY);
  // v1.8.3 — warm every locale the user might request, not just the
  // User.locale. The per-status cache key is
  // `insights.<metric>-status.<locale>`, but the client sends the active
  // UI-cookie / Accept-Language locale (narrowed to de|en), which can
  // differ from the persisted User.locale (e.g. null → "de" in the cron
  // while the browser cookie is "en"). Warming only the User.locale left
  // the locale the client actually reads cold, so the first visit still
  // ran a live generation per card — the exact freeze this release closes.
  const tasks = generators.flatMap((generate) =>
    locales.map((locale) =>
      limit(async () => {
        try {
          const outcome = await generate(userId, { locale, force });
          return outcome.hasProvider && !outcome.cached ? 1 : 0;
        } catch {
          // A single card's generation failing must not abort the rest of
          // the warm pass for this user, nor the cron's user loop.
          return 0;
        }
      }),
    ),
  );
  const results = await Promise.all(tasks);
  return results.reduce((sum: number, n) => sum + n, 0);
}

/**
 * v1.8.7.1 — warm the generic per-HealthKit-metric assessment caches for
 * one user, but ONLY for metrics that have data. A single grouped count
 * answers "which metric types does this user have readings for?" in one
 * query, so the cron never burns a (cheap) per-metric count nor (costly)
 * an LLM call on a metric the user has never logged. The generic
 * generator's own empty-data guard is the second line of defence, but the
 * up-front filter keeps the cron from forcing ~30 metric generators per
 * user when most have no data.
 *
 * Returns the count of fresh provider-backed assessments written.
 */
async function warmGenericMetricCaches(
  prisma: PrismaClient,
  userId: string,
  locales: ReadonlyArray<"de" | "en">,
  // See `warmPerStatusCaches` — `false` is the refill-only fallback mode.
  force = true,
): Promise<number> {
  // One distinct read: the set of MeasurementTypes the user has live
  // rows for. Best-effort — a read failure (or a worker prisma surface
  // without `measurement`) yields zero metrics rather than aborting the
  // user's whole pre-generation loop.
  let rows: Array<{ type: string }>;
  try {
    rows = await prisma.measurement.findMany({
      where: { userId, deletedAt: null },
      distinct: ["type"],
      select: { type: true },
    });
  } catch {
    return 0;
  }
  const typesWithData = new Set(rows.map((r) => r.type));

  const metricsWithData = METRIC_STATUS_IDS.filter(
    (id: MetricStatusMetricId) => {
      const meta = getMetricStatusMeta(id);
      return meta !== null && typesWithData.has(meta.measurementType);
    },
  );
  if (metricsWithData.length === 0) return 0;

  const limit = pLimit(WARM_PASS_CONCURRENCY);
  const tasks = metricsWithData.flatMap((metric) =>
    locales.map((locale) =>
      limit(async () => {
        try {
          const outcome = await generateMetricStatus({
            metric,
            userId,
            locale,
            force,
          });
          // `insufficient` never reaches here (we pre-filtered to
          // metrics with data), but guard anyway: count only a fresh
          // provider-backed assessment.
          return outcome.hasProvider &&
            !outcome.cached &&
            outcome.insufficient !== true
            ? 1
            : 0;
        } catch {
          return 0;
        }
      }),
    ),
  );
  const results = await Promise.all(tasks);
  return results.reduce((sum: number, n) => sum + n, 0);
}

interface PregenerateCandidate {
  id: string;
  locale: string | null;
}

/**
 * Discovery query — coach-enabled users with a stale or missing
 * comprehensive-insight cache, oldest-cache-first so the staleest users
 * are served before the per-run cap bites. Exported so the cron test
 * can pin the WHERE shape without a live LLM.
 */
export async function findPregenerateCandidates(
  prisma: PrismaClient,
  now: Date,
  cap: number,
): Promise<PregenerateCandidate[]> {
  const staleBefore = new Date(now.getTime() - PREGENERATE_STALE_MS);
  return prisma.user.findMany({
    where: {
      disableCoach: false,
      OR: [
        { insightsCachedAt: null },
        { insightsCachedAt: { lt: staleBefore } },
      ],
    },
    // nulls-first is the default ascending order in Postgres, so
    // never-generated users sort ahead of merely-stale ones.
    orderBy: { insightsCachedAt: "asc" },
    take: cap,
    select: { id: true, locale: true },
  });
}

/**
 * Non-German locales resolve to ENGLISH (matching
 * `status-shared.normalizeLocale` and the no-key fallback routing) so a
 * fr/es/it/pl account gets English AI prose, not German.
 */
function normalizeLocale(value: string | null): "de" | "en" {
  return value === "de" ? "de" : "en";
}

/**
 * Run one pre-generation pass. Pure of pg-boss so the unit test can
 * drive it directly. The master assistant kill-switch short-circuits
 * the whole run (no candidate generation when the operator disabled the
 * coach surface globally). Per-user budget gate runs BEFORE the LLM
 * call so a no-op night costs only rate-limit upserts.
 */
export async function runInsightPregenerate(
  prisma: PrismaClient,
  options: {
    now?: Date;
    cap?: number;
    /** Injected for the test — defaults to the real generator. */
    generate?: (
      userId: string,
      opts: { locale: "de" | "en"; force?: boolean; signal?: AbortSignal },
    ) => Promise<GenerateOutcome>;
    /** Injected for the test — defaults to the seven real status generators. */
    statusGenerators?: ReadonlyArray<StatusGenerator>;
    /**
     * v1.8.7.1 — injected for the test. Defaults to the real generic
     * metric warm pass; the test stubs it to assert it runs only for
     * data-bearing metrics without a live LLM.
     */
    warmGenericMetrics?: (
      userId: string,
      locales: ReadonlyArray<"de" | "en">,
      force?: boolean,
    ) => Promise<number>;
  } = {},
): Promise<PregenerateRunResult> {
  const now = options.now ?? new Date();
  const cap = options.cap ?? PREGENERATE_BATCH_CAP;
  const generate = options.generate ?? generateComprehensiveInsight;
  const statusGenerators =
    options.statusGenerators ?? DEFAULT_STATUS_GENERATORS;
  const warmGenericMetrics =
    options.warmGenericMetrics ??
    ((userId: string, locales: ReadonlyArray<"de" | "en">, force?: boolean) =>
      warmGenericMetricCaches(prisma, userId, locales, force));

  const result: PregenerateRunResult = {
    total: 0,
    generated: 0,
    cached: 0,
    skipped: 0,
    failed: 0,
    budgetBlocked: 0,
    assessmentsWarmed: 0,
    metricAssessmentsWarmed: 0,
  };

  // Master kill-switch — when the operator disabled the briefing
  // surface globally there is nothing to pre-generate.
  const flags = await getAssistantFlags();
  if (!flags.briefing) return result;

  const candidates = await findPregenerateCandidates(prisma, now, cap);
  result.total = candidates.length;

  for (const candidate of candidates) {
    // Budget gate — one COMPREHENSIVE pre-generation per user per 20 h.
    // The route's on-demand path uses a different bucket
    // (`insights:${userId}`), so this never starves a user's manual
    // regenerate quota. The gate bounds the comprehensive cost only: a
    // blocked user still gets the refill-only status warm below, because
    // the 02:xx status crons already skipped every pregenerate candidate
    // on the assumption that THIS pass warms their cards — exiting early
    // here left those cards cold until the first on-visit generation.
    const budget = await checkRateLimit(
      `insight-pregenerate:${candidate.id}`,
      1,
      PREGENERATE_BUDGET_WINDOW_MS,
    );

    const locale = normalizeLocale(candidate.locale);
    let outcome: GenerateOutcome | null = null;
    if (!budget.allowed) {
      result.budgetBlocked++;
    } else {
      // Force a fresh generation: the discovery window (20 h) is shorter
      // than the generator's 24 h cache TTL, so without `force` a user
      // whose cache is 20–24 h old would be discovered, consume the
      // budget bucket, then short-circuit to `cached` with no actual
      // pre-generation — defeating the "warm the cache before the user's
      // morning visit" intent for the common case. The per-user budget
      // bucket (above) is what bounds cost, not the TTL re-check.
      //
      // Bounded budget + abort (v1.16.1): one stalled provider must not
      // pin the whole batch behind a single candidate, and `withTimeout`
      // alone cannot cancel the detached generation — without the abort a
      // late resolve would reach `evictPerStatusInsightCache` and delete
      // the rows the warm passes write below (the same race the forced
      // single-user warm closes).
      const controller = new AbortController();
      const bounded = await withTimeout(
        () =>
          generate(candidate.id, {
            locale,
            force: true,
            signal: controller.signal,
          }),
        COMPREHENSIVE_WARM_TIMEOUT_MS,
        null,
        () => controller.abort(),
      );
      if (bounded.timedOut || bounded.errored || bounded.value === null) {
        result.failed++;
      } else {
        outcome = bounded.value;
        switch (outcome.status) {
          case "generated":
            result.generated++;
            break;
          case "cached":
            result.cached++;
            break;
          case "skipped":
            result.skipped++;
            break;
          case "failed":
            result.failed++;
            break;
        }
      }
    }

    // Warm the per-metric assessment caches. Two modes:
    //
    //   - After a `generated` or `cached` comprehensive the generator's
    //     write evicted (`evictPerStatusInsightCache`) every per-status
    //     row, so the warm forces a fresh generation per card.
    //   - On every other path (budget-blocked, failed, timed-out,
    //     consent-skipped comprehensive) the warm still runs, but
    //     refill-only (`force: false`): the per-status cache is keyed on
    //     today's dateKey, so a card already generated today is a cheap
    //     cache read while a cold card generates. Before v1.16.1 these
    //     paths skipped the warm entirely — and because the 02:xx status
    //     crons skip every pregenerate candidate, a single failed or
    //     budget-blocked comprehensive left ALL of that user's cards cold
    //     until the first on-visit generation.
    //
    // The only outcome with nothing to warm is a missing provider
    // (`skipped`/`no-provider`): the per-card generators would no-op to
    // their fallbacks anyway, so the pass is skipped to save the
    // chain-resolves.
    if (outcome?.status === "skipped" && outcome.reason === "no-provider") {
      continue;
    }
    const evicted =
      outcome?.status === "generated" || outcome?.status === "cached";
    result.assessmentsWarmed += await warmPerStatusCaches(
      candidate.id,
      // Warm both supported locales — the client reads against the active
      // UI locale, which can differ from the persisted User.locale.
      ["de", "en"],
      statusGenerators,
      evicted,
    );
    // v1.8.7.1 — warm the generic per-HealthKit-metric caches too, for
    // the user's data-bearing metrics only (the helper filters via one
    // grouped count, so an empty metric never reaches the provider).
    result.metricAssessmentsWarmed += await warmGenericMetrics(
      candidate.id,
      ["de", "en"],
      evicted,
    );
  }

  // Wide-event tally so the nightly dashboard can track how many
  // comprehensive insights and per-metric assessments each tick wrote.
  annotate({
    action: { name: "insights.pregenerate.run" },
    meta: {
      total: result.total,
      generated: result.generated,
      cached: result.cached,
      skipped: result.skipped,
      failed: result.failed,
      budget_blocked: result.budgetBlocked,
      assessments_warmed: result.assessmentsWarmed,
      metric_assessments_warmed: result.metricAssessmentsWarmed,
    },
  });

  return result;
}

/**
 * v1.8.7.1 — forced full warm for ONE user, on demand.
 *
 * Runs the same pipeline the nightly tick runs per candidate — the
 * comprehensive insight (which carries the daily briefing), the seven
 * specialised `*-status` assessments, and every data-bearing generic
 * `metric:<ID>` assessment — but for a single explicit `userId` and
 * WITHOUT the per-user 20 h budget bucket. The endpoint that enqueues this
 * job carries its own short anti-spam rate-limit (one warm per few
 * minutes), so the forced path can skip the nightly budget while staying
 * bounded against abuse.
 *
 * Safety is preserved by the helpers it reuses, not by a budget gate:
 *   - The comprehensive generator no-ops to `{ status: "skipped" }` when
 *     no provider is configured (no LLM call).
 *   - `warmGenericMetricCaches` filters to metrics the user has rows for
 *     via one grouped read, so an empty metric never reaches the provider.
 *   - Each generator forces a fresh write but is idempotent — re-running
 *     it just rewrites the same cache row; concurrent enqueues collapse via
 *     the queue `singletonKey`.
 *
 * Like the nightly cron, the forced path warms BOTH locales (de+en): its
 * own comprehensive step evicts every per-status row across both locale
 * families, and the refill-only mode keeps the second family's cost at
 * exactly the cards that are cold. The caller's `locale` still picks the
 * language of the comprehensive briefing itself.
 *
 * The three sections are decoupled: the comprehensive step runs under its
 * own bounded budget (`COMPREHENSIVE_WARM_TIMEOUT_MS`) and its
 * failure / timeout / skip is non-fatal — the per-status (7) and
 * generic-metric (~30) warm passes ALWAYS run afterwards. The earlier
 * design short-circuited both passes on a non-`generated`/`cached`
 * comprehensive, so a single slow briefing generation left every card cold
 * and the user back on the lazy 30–60 s on-first-click path. The per-card
 * generators each resolve their own provider chain and bound their own
 * provider call, so a missing provider costs a cheap chain-resolve and a
 * degraded one is capped per card — running them after a failed
 * comprehensive can never multiply a stall. The result reports each
 * section's outcome independently so a partial warm is observable.
 */
export async function forceWarmUser(
  prisma: PrismaClient,
  userId: string,
  locale: "de" | "en",
  options: {
    generate?: (
      userId: string,
      opts: { locale: "de" | "en"; force?: boolean; signal?: AbortSignal },
    ) => Promise<GenerateOutcome>;
    statusGenerators?: ReadonlyArray<StatusGenerator>;
    warmGenericMetrics?: (
      userId: string,
      locales: ReadonlyArray<"de" | "en">,
      force?: boolean,
    ) => Promise<number>;
  } = {},
): Promise<ForceWarmResult> {
  const generate = options.generate ?? generateComprehensiveInsight;
  const statusGenerators =
    options.statusGenerators ?? DEFAULT_STATUS_GENERATORS;
  const warmGenericMetrics =
    options.warmGenericMetrics ??
    ((id: string, locales: ReadonlyArray<"de" | "en">, force?: boolean) =>
      warmGenericMetricCaches(prisma, id, locales, force));

  const result: ForceWarmResult = {
    comprehensive: "skipped",
    assessmentsWarmed: 0,
    metricAssessmentsWarmed: 0,
  };

  // v1.9.0 — gate each section on the flag for the surface it actually
  // warms, matching the route. The HTTP route admits this job on the per-user
  // `insightStatus` surface, so warming the per-status + generic-metric cards
  // must run whenever `insightStatus` is enabled. Only the comprehensive
  // briefing belongs to the `briefing` surface — gating the whole warm on
  // `briefing` (the previous behaviour) let an operator's global `briefing`
  // kill-switch silently suppress the assessment cards the user has enabled.
  // When the master assistant switch is off both flags resolve false, so the
  // whole thing still no-ops.
  const flags = await getAssistantFlags();
  if (!flags.briefing && !flags.insightStatus) return result;

  // Warm BOTH supported locales, matching the nightly pass. A fresh
  // comprehensive generation evicts every per-status cache row in both
  // locale families (`evictPerStatusInsightCache` deletes by scope, not
  // by locale) — refilling only the caller's active locale left the
  // other family cold, so an account read through two surfaces (German
  // web UI + an English Accept-Language client) regenerated the second
  // family card-by-card on its next visits, all day, every day. The
  // refill mode below short-circuits to the cache for any card already
  // generated today, so the second locale costs only the cards that are
  // actually cold.
  const locales: ReadonlyArray<"de" | "en"> = ["de", "en"];

  // The comprehensive step gets its own bounded budget and its failure is
  // non-fatal. A slow or stalled briefing generation must not short-circuit
  // the per-status + generic-metric passes — those are the ~37 cards the
  // user actually clicks first, and warming them is independent of the
  // comprehensive insight (each generator resolves its own provider chain
  // and writes its own cache row). A timeout / error / skipped comprehensive
  // now falls through to the warm passes instead of aborting the whole job.
  //
  // On a timeout `withTimeout` cannot cancel the detached generation; without
  // a cut-off a late-resolving comprehensive would reach its own
  // `evictPerStatusInsightCache` and delete the rows the warm passes write
  // below. Thread an AbortController so the timeout aborts the generation
  // before it can touch the cache.
  if (flags.briefing) {
    const controller = new AbortController();
    const comprehensive = await withTimeout(
      () => generate(userId, { locale, force: true, signal: controller.signal }),
      COMPREHENSIVE_WARM_TIMEOUT_MS,
      null,
      () => controller.abort(),
    );
    if (comprehensive.timedOut) {
      result.comprehensive = "timeout";
    } else if (comprehensive.errored || comprehensive.value === null) {
      result.comprehensive = "failed";
    } else {
      result.comprehensive = comprehensive.value.status;
    }
  }

  // Run the per-status + generic-metric warm passes whenever the
  // `insightStatus` surface is enabled, regardless of the comprehensive
  // outcome. Each generator independently no-ops to its no-key fallback when
  // no provider is configured (no LLM call) and serves its fallback without
  // persisting on a per-card timeout, so running them after a failed
  // comprehensive is safe and bounded by their own per-card budgets. The only
  // outcome that has nothing to warm is a missing provider, and the
  // generators detect that themselves at near-zero cost.
  if (flags.insightStatus) {
    // Mirror the nightly loop's force/refill split: only a `generated`
    // comprehensive ran `evictPerStatusInsightCache`, so only then must
    // every card re-generate. (The forced generation above never returns
    // `cached` — `force: true` skips the 24 h cache-hit branch.) On a
    // failed / timed-out / skipped comprehensive the rows survived —
    // refill-only (`force: false`) lets a card already generated today
    // short-circuit to its cache, which is what keeps the second locale
    // family cheap.
    const evicted = result.comprehensive === "generated";
    result.assessmentsWarmed = await warmPerStatusCaches(
      userId,
      locales,
      statusGenerators,
      evicted,
    );
    result.metricAssessmentsWarmed = await warmGenericMetrics(
      userId,
      locales,
      evicted,
    );
  }

  annotate({
    action: { name: "insights.pregenerate.force" },
    meta: {
      locale,
      comprehensive: result.comprehensive,
      assessments_warmed: result.assessmentsWarmed,
      metric_assessments_warmed: result.metricAssessmentsWarmed,
    },
  });

  return result;
}
