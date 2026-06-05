/**
 * v1.13.2 — AI-warm layer for the per-derived-SCORE assessment.
 *
 * The deterministic text (in `derived-assessment.ts`) always fills the field
 * synchronously, so a provider-less account and the demo are never empty.
 * THIS module adds the warmer AI prose on top, reusing the exact
 * stale-while-revalidate plumbing the per-metric status cards use:
 *
 *   - `resolveDerivedAssessment` (the route entry) reads a fresh cached AI
 *     assessment for today; on a hit it serves it (source = provider type).
 *     On a miss it serves the deterministic text and, when a provider is
 *     usable, fire-and-forget enqueues a warm generation out of band — the
 *     GET never blocks on an LLM round-trip.
 *   - `generateDerivedScoreAssessment` (the worker entry) builds the
 *     signal-led prompt, runs the user's provider chain through
 *     `runStatusCompletion`, and persists the text under the same
 *     `auditLog` cache row the status cards use.
 *
 * The cache action is `insights.derived-score:<ID>-status.<locale>` so the
 * read, the worker, and the enqueue helper all speak one vocabulary.
 *
 * Server-only — reads the DB + the provider chain.
 */
import {
  getBaseSystemPrompt,
  PROMPT_VERSION,
} from "@/lib/ai/prompts/base-system";
import {
  normalizeLocale,
  normalizeSummaryText,
  parseSummaryFromContent,
  persistStatusInsight,
  type SupportedLocale,
} from "@/lib/insights/status-shared";
import { runStatusCompletion } from "@/lib/insights/status-provider";
import {
  readFreshStatusText,
  resolveReadOnlyStatusMiss,
  statusCacheAction,
} from "@/lib/insights/status-cache";
import { toBerlinDayKey } from "@/lib/tz/resolver";
import { annotate } from "@/lib/logging/context";
import {
  buildScoreSignal,
  isAssessableDerivedScore,
  resolveDeterministicAssessment,
  type DerivedAssessment,
} from "./derived-assessment";
import type { Derived } from "./types";
import type { DerivedMetricId } from "./registry";
import type { MetricSignal } from "@/lib/insights/metric-signal";

/** The `metric` scope id this generator warms — `derived-score:<ID>`. */
export function derivedScoreScope(
  metric: DerivedMetricId,
): `derived-score:${DerivedMetricId}` {
  return `derived-score:${metric}`;
}

/** Read a `derived-score:<ID>` scope back to its `DerivedMetricId`. */
export function parseDerivedScoreScope(scope: string): DerivedMetricId | null {
  if (!scope.startsWith("derived-score:")) return null;
  return scope.slice("derived-score:".length) as DerivedMetricId;
}

// ── prompt ────────────────────────────────────────────────────────────────

function scoreSystemPrompt(locale: SupportedLocale): string {
  const base = getBaseSystemPrompt(locale);
  const section =
    locale === "en"
      ? `ARCHETYPE — COMPOSITE WELLNESS SCORE:
- This is a 0–100 composite score, not a raw measurement. Explain WHY it sits where it does by naming the 1–2 contributors in \`signal.contributors[]\` that moved it most — a lower contributor value drags the score down. Each contributor is itself 0–100.
- Lead with the score and its standing, then attribute it to the contributor(s). Do not invent a contributor that is not listed. When there are no contributors, use the trend (signal.delta) instead.
- This is a daily wellness proxy, not a clinical or training-recovery verdict. Stay descriptive, never diagnostic.`
      : `ARCHETYP — ZUSAMMENGESETZTER WELLNESS-SCORE:
- Das ist ein 0–100-Kompositscore, keine Rohmessung. Erkläre, WARUM er dort liegt, indem du die 1–2 Beiträge aus \`signal.contributors[]\` nennst, die ihn am stärksten bewegt haben — ein niedriger Beitragswert zieht den Score nach unten. Jeder Beitrag ist selbst 0–100.
- Führe mit dem Score und seiner Einordnung, dann ordne ihn den Beiträgen zu. Erfinde keinen Beitrag, der nicht gelistet ist. Gibt es keine Beiträge, nutze stattdessen den Trend (signal.delta).
- Das ist ein täglicher Wellness-Indikator, kein klinisches Urteil und keine Trainings-Recovery-Bewertung. Bleibe beschreibend, nie diagnostisch.`;
  return `${base}\n\n${section}`;
}

function scoreUserPrompt(
  signal: MetricSignal,
  band: string,
  todayKey: string,
  locale: SupportedLocale,
): string {
  const snapshot = JSON.stringify(
    { promptVersion: PROMPT_VERSION, generatedForDay: todayKey, band, signal },
    null,
    2,
  );
  if (locale === "en") {
    return `Date: ${todayKey} (Europe/Berlin)
Write one short assessment of why ${signal.metric} is the score it is today: name the score and its standing, then attribute it to the 1–2 contributors that moved it most. Keep it to 2–3 sentences, descriptive only.

${snapshot}`;
  }
  return `Datum: ${todayKey} (Europe/Berlin)
Schreibe eine kurze Einschätzung, warum ${signal.metric} heute diesen Score hat: nenne den Score und seine Einordnung und ordne ihn dann den 1–2 stärksten Beiträgen zu. Halte dich an 2–3 Sätze, rein beschreibend.

${snapshot}`;
}

// ── read (route entry) ──────────────────────────────────────────────────

/**
 * Resolve the per-score assessment for the route. Always returns the
 * deterministic text (never empty for an ok score); serves a fresh cached AI
 * assessment instead when one exists for today, and warms one out of band on
 * a miss. Returns null when the metric is not assessable or status !== "ok".
 */
export async function resolveDerivedAssessment(args: {
  metric: DerivedMetricId;
  userId: string;
  derived: Derived<unknown>;
  locale: string | null | undefined;
  now?: Date;
}): Promise<DerivedAssessment | null> {
  const now = args.now ?? new Date();
  const locale = normalizeLocale(args.locale);

  const deterministic = resolveDeterministicAssessment(
    args.metric,
    args.derived,
    locale,
    now,
  );
  // Not assessable, or status !== ok → no field (the locked contract).
  if (!deterministic) return null;

  const scope = derivedScoreScope(args.metric);
  const cacheAction = statusCacheAction(scope, locale);
  const todayKey = toBerlinDayKey(now);

  // Fresh AI text for today → serve it (warmer prose overrides the template).
  const fresh = await readFreshStatusText({
    userId: args.userId,
    cacheAction,
    todayKey,
    force: false,
  });
  if (fresh) {
    return { text: fresh.text, source: "ai", updatedAt: fresh.updatedAt };
  }

  // No fresh AI text. Warm one out of band (best-effort, never blocks): the
  // read-only resolver enqueues a generation when a provider is usable and
  // de-dupes per (user, scope, locale). Serve the deterministic text now; the
  // next read upgrades to the warmed prose.
  await resolveReadOnlyStatusMiss({
    userId: args.userId,
    metric: scope,
    locale,
  });

  return deterministic;
}

// ── generate (worker entry) ──────────────────────────────────────────────

/**
 * Worker entry: build the signal-led prompt for one derived score, run the
 * provider chain, and persist the AI assessment under the shared status-cache
 * row. Recomputes the derived value via the passed `derived` so the worker
 * runs the same numbers the route did. A no-provider / timeout / error
 * outcome simply writes nothing — the route keeps serving the deterministic
 * text, so the field is never empty.
 */
export async function generateDerivedScoreAssessment(args: {
  metric: DerivedMetricId;
  userId: string;
  derived: Derived<unknown>;
  locale: string | null | undefined;
  now?: Date;
}): Promise<void> {
  const now = args.now ?? new Date();
  const locale = normalizeLocale(args.locale);
  if (!isAssessableDerivedScore(args.metric)) return;
  if (args.derived.status !== "ok") return;

  const signal = buildScoreSignal(args.metric, args.derived.value, locale);
  if (!signal) return;
  const band =
    (args.derived.value as { band?: string }).band ?? "yellow";

  const scope = derivedScoreScope(args.metric);
  const cacheAction = statusCacheAction(scope, locale);
  const todayKey = toBerlinDayKey(now);

  const outcome = await runStatusCompletion({
    userId: args.userId,
    cacheAction,
    consentSurface: "insights",
    systemPrompt: scoreSystemPrompt(locale),
    userPrompt: scoreUserPrompt(signal, band, todayKey, locale),
    temperature: 0.45,
    maxTokens: 600,
  });

  if (outcome.kind !== "ok") {
    annotate({
      action: { name: "insights.derived-assessment.skip" },
      meta: { metric: args.metric, reason: outcome.kind },
    });
    return;
  }

  const text = normalizeSummaryText(parseSummaryFromContent(outcome.content));
  if (!text) return;

  await persistStatusInsight({
    userId: args.userId,
    cacheAction,
    todayKey,
    locale,
    text,
    providerType: outcome.providerType,
    model: outcome.model,
    tokensUsed: outcome.tokensUsed,
  });
  annotate({
    action: { name: "insights.derived-assessment.warmed" },
    meta: { metric: args.metric, provider: outcome.providerType },
  });
}
