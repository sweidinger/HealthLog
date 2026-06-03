/**
 * v1.11.0 W3 — period-narrative GENERATOR (Pillar P1).
 *
 * A sibling of `generateComprehensiveInsight`: it feeds the W2
 * `buildPeriodNarrativeContext` output — a compact, provenance-carrying
 * `label + number + source` context — into the user's provider chain with a
 * TIGHT, descriptive-never-causal prompt and persists the generated prose in
 * the typed `insight_narratives` table (AES-256-GCM at rest).
 *
 * Honesty floor (inherited verbatim from the W1/W2 layers it consumes):
 *  - The context is the only ground truth. The prompt forbids inventing any
 *    number, trend, driver, or threshold not present in the context.
 *  - Drivers are already BH-FDR survivors with conservative `interpretation`
 *    strings; the narrative may restate them as associations, NEVER as
 *    causes.
 *  - An `insufficient` context (too little history) yields NO narrative — the
 *    generator returns `{ status: "insufficient" }` and writes nothing, so a
 *    sparse account never gets a fabricated story.
 *  - No provider configured → `{ status: "skipped", reason: "no-provider" }`,
 *    no LLM call. A provider timeout / error is non-fatal and writes nothing.
 *
 * Cache + stale-while-revalidate mirror the per-status assessments: a fresh
 * read serves today's row instantly; a regenerate upserts the single
 * (user, period, locale) row in place (delete/regenerate-clean by
 * construction — the unique index forbids duplicates).
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { encrypt, decrypt } from "@/lib/crypto";
import { getLocalDateParts } from "@/lib/timezone";
import { annotate } from "@/lib/logging/context";
import { runStatusCompletion } from "@/lib/insights/status-provider";
import {
  buildPeriodNarrativeContext,
  type NarrativePeriod,
  type PeriodNarrativeContext,
} from "@/lib/insights/narrative/period-narrative";

/**
 * Stable identifier for the narrative prompt revision. Bumped whenever the
 * prompt below changes so the cross-feature attribution aggregator can slice
 * quality per (provider × prompt) and a prompt change is observable.
 */
export const NARRATIVE_PROMPT_VERSION = "1.11.0" as const;

/** A narrative cached this recently is served without regenerating. */
const NARRATIVE_FRESH_MS = 20 * 60 * 60 * 1000;

export type NarrativeGenerateOutcome =
  | { status: "cached" }
  | { status: "generated"; providerType: string }
  | { status: "skipped"; reason: "no-provider" }
  | { status: "insufficient" }
  | { status: "failed"; reason: string };

interface GenerateOptions {
  /** Which period to narrate. */
  period: NarrativePeriod;
  /** Resolved UI locale for the prompt + row. */
  locale: "de" | "en";
  /** Skip the freshness short-circuit and force a fresh generation. */
  force?: boolean;
  /** Injected clock for deterministic tests; defaults to now. */
  now?: Date;
  /** Injected for tests — defaults to the real DB context assembler. */
  buildContext?: typeof buildPeriodNarrativeContext;
  /** Injected for tests — defaults to the real bounded provider call. */
  runCompletion?: typeof runStatusCompletion;
  /** Injected for tests — the shared client by default. */
  prisma?: PrismaClient;
}

/** The labels-only provenance the surface renders as ⓘ chips. */
export interface NarrativeProvenancePayload {
  metrics: string[];
  window: { from: string; to: string };
  pairsTested: number;
  fdrQ: number;
  computedAt: string;
}

/** UTC YYYY-MM-DD boundary key for a row, in the user's tz. */
function dateKeyFor(now: Date, tz: string): string {
  const { year, month, day } = getLocalDateParts(now, tz);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// ── prompt ──────────────────────────────────────────────────────────────

const SYSTEM_PROMPT_EN = `You summarise one person's health-tracking PERIOD (a week or a month) for that person.
Prompt version: ${NARRATIVE_PROMPT_VERSION}.

Hard rules:
- The supplied CONTEXT is the ONLY source of truth. Never state a number, trend, driver, or threshold that is not in it.
- Be DESCRIPTIVE, never CAUSAL. Say "X moved with Y" or "X was associated with Y", never "X caused Y" or "because of X".
- The listed drivers already survived statistical multiple-comparison control; restate them only as associations and keep their conservative meaning.
- No diagnosis, no medical advice, no alarm. Calm, factual, second person ("your").
- 2 to 4 short sentences. Plain text only — no markdown, no headings, no bullet points, no emojis.
- If the context is thin, say plainly that there is little to report this period rather than inventing detail.`;

const SYSTEM_PROMPT_DE = `Du fasst den Gesundheits-Tracking-ZEITRAUM einer Person (eine Woche oder einen Monat) für diese Person zusammen.
Prompt-Version: ${NARRATIVE_PROMPT_VERSION}.

Feste Regeln:
- Der bereitgestellte KONTEXT ist die EINZIGE Wahrheitsquelle. Nenne nie eine Zahl, einen Trend, einen Zusammenhang oder einen Schwellenwert, der nicht darin steht.
- Sei BESCHREIBEND, nie URSÄCHLICH. Sage "X bewegte sich mit Y" oder "X war mit Y assoziiert", nie "X verursachte Y" oder "wegen X".
- Die genannten Zusammenhänge haben bereits die statistische Mehrfachvergleichskorrektur überstanden; gib sie nur als Assoziationen wieder und bewahre ihre vorsichtige Bedeutung.
- Keine Diagnose, kein medizinischer Rat, keine Panik. Ruhig, sachlich, in der zweiten Person ("dein").
- 2 bis 4 kurze Sätze. Nur Klartext — kein Markdown, keine Überschriften, keine Aufzählungen, keine Emojis.
- Wenn der Kontext dünn ist, sage klar, dass es in diesem Zeitraum wenig zu berichten gibt, statt Details zu erfinden.`;

/** Render the typed context into a compact, model-readable block. */
export function buildNarrativeUserPrompt(
  context: PeriodNarrativeContext,
  locale: "de" | "en",
): string {
  const periodLabel =
    context.period === "week"
      ? locale === "de"
        ? "die letzte Woche (7 Tage)"
        : "the last week (7 days)"
      : locale === "de"
        ? "den letzten Monat (30 Tage)"
        : "the last month (30 days)";

  const lines: string[] = [];
  lines.push(
    locale === "de"
      ? `Zeitraum: ${periodLabel}, verglichen mit dem vorherigen gleich langen Zeitraum.`
      : `Period: ${periodLabel}, compared with the prior period of equal length.`,
  );

  if (context.metricDeltas.length > 0) {
    lines.push(locale === "de" ? "Veränderungen:" : "Changes:");
    for (const d of context.metricDeltas) {
      if (d.current === null) continue;
      const unit = d.unit ? ` ${d.unit}` : "";
      const deltaPart =
        d.delta === null
          ? locale === "de"
            ? "(kein Vergleich möglich)"
            : "(no comparison available)"
          : `${d.delta >= 0 ? "+" : ""}${d.delta}${unit}${
              d.deltaPercent === null ? "" : ` (${d.deltaPercent}%)`
            }`;
      lines.push(
        `- ${d.type}: ${d.current}${unit} ${deltaPart} [${d.currentDays}d]`,
      );
    }
  }

  if (context.bandTransitions.length > 0) {
    lines.push(
      locale === "de"
        ? "Persönlicher Normbereich (Median ± Streuung des Vorzeitraums):"
        : "Personal typical range (prior-period median ± spread):",
    );
    for (const b of context.bandTransitions) {
      const where =
        b.direction === "above"
          ? locale === "de"
            ? "über dem Bereich"
            : "above the range"
          : b.direction === "below"
            ? locale === "de"
              ? "unter dem Bereich"
              : "below the range"
            : locale === "de"
              ? "im Bereich"
              : "in range";
      lines.push(
        `- ${b.type}: ${b.center} (${b.bandLow}–${b.bandHigh}) → ${where}`,
      );
    }
  }

  if (context.drivers.length > 0) {
    lines.push(
      locale === "de"
        ? "Statistisch belegte Assoziationen (NICHT kausal):"
        : "Statistically supported associations (NOT causal):",
    );
    for (const dr of context.drivers) {
      lines.push(
        `- ${dr.behaviour} ~ ${dr.outcome}: r=${dr.r}, q=${dr.qValue}, n=${dr.n} — ${dr.interpretation}`,
      );
    }
  }

  if (context.coincidentFlags.length > 0) {
    lines.push(
      locale === "de"
        ? `Tage mit mehreren gleichzeitig außerhalb des Normbereichs liegenden Werten: ${context.coincidentFlags.length}.`
        : `Days with several vitals outside the typical range together: ${context.coincidentFlags.length}.`,
    );
  }

  lines.push(
    locale === "de"
      ? `(${context.pairsTested} Paare getestet, FDR-Ziel q=${context.fdrQ}.)`
      : `(${context.pairsTested} pairs tested, FDR target q=${context.fdrQ}.)`,
  );

  return lines.join("\n");
}

/**
 * Generate + cache the period narrative for one user. Pure pipeline; no
 * rate-limit / request concerns (the route + cron add those). Returns a typed
 * outcome the caller can log + branch on. Never throws on a provider failure
 * (a cron batch loop must continue to the next user).
 */
export async function generatePeriodNarrative(
  userId: string,
  options: GenerateOptions,
): Promise<NarrativeGenerateOutcome> {
  const { locale } = options;
  const force = options.force === true;
  const now = options.now ?? new Date();
  const prisma = options.prisma ?? defaultPrisma;
  const buildContext = options.buildContext ?? buildPeriodNarrativeContext;
  const runCompletion = options.runCompletion ?? runStatusCompletion;
  const period = options.period;

  // Freshness short-circuit — a recently-generated row is served as-is.
  if (!force) {
    const existing = await prisma.insightNarrative.findUnique({
      where: { userId_period_locale: { userId, period, locale } },
      select: { updatedAt: true },
    });
    if (
      existing &&
      now.getTime() - existing.updatedAt.getTime() < NARRATIVE_FRESH_MS
    ) {
      return { status: "cached" };
    }
  }

  const context = await buildContext(userId, { period, now });
  if (context.status === "insufficient") {
    annotate({
      action: { name: "insights.narrative.insufficient" },
      meta: { period, reason: context.reason },
    });
    return { status: "insufficient" };
  }

  const profile = await prisma.user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  const tz = profile?.timezone ?? "Europe/Berlin";

  const completion = await runCompletion({
    userId,
    cacheAction: `insights.narrative.${period}.${locale}`,
    systemPrompt: locale === "de" ? SYSTEM_PROMPT_DE : SYSTEM_PROMPT_EN,
    userPrompt: buildNarrativeUserPrompt(context, locale),
    temperature: 0.3,
    maxTokens: 400,
  });

  if (completion.kind === "none") {
    return { status: "skipped", reason: "no-provider" };
  }
  if (completion.kind === "timeout") {
    annotate({
      action: { name: "insights.narrative.timeout" },
      meta: { period, locale },
    });
    return { status: "failed", reason: "timeout" };
  }
  if (completion.kind === "error") {
    return { status: "failed", reason: "provider-error" };
  }

  const text = completion.content.trim();
  if (text.length === 0) {
    return { status: "failed", reason: "empty" };
  }

  const provenance: NarrativeProvenancePayload = {
    metrics: context.provenance.metrics,
    window: context.provenance.window,
    pairsTested: context.pairsTested,
    fdrQ: context.fdrQ,
    computedAt: context.provenance.computedAt,
  };

  // Upsert the single (user, period, locale) row in place — delete/regenerate
  // clean by construction. The prose is held AES-256-GCM at rest.
  const encryptedContent = encryptToBytes(text);
  const dateKey = dateKeyFor(now, tz);
  await prisma.insightNarrative.upsert({
    where: { userId_period_locale: { userId, period, locale } },
    create: {
      userId,
      period,
      locale,
      dateKey,
      encryptedContent,
      provenanceJson: JSON.stringify(provenance),
      providerType: completion.providerType,
      promptVersion: NARRATIVE_PROMPT_VERSION,
    },
    update: {
      dateKey,
      encryptedContent,
      provenanceJson: JSON.stringify(provenance),
      providerType: completion.providerType,
      promptVersion: NARRATIVE_PROMPT_VERSION,
    },
  });

  annotate({
    action: { name: "insights.narrative.generated" },
    meta: { period, locale, provider: completion.providerType },
  });
  return { status: "generated", providerType: completion.providerType };
}

/** The narrative row, decrypted for a read. */
export interface NarrativeRead {
  period: NarrativePeriod;
  locale: "de" | "en";
  text: string;
  dateKey: string;
  provenance: NarrativeProvenancePayload | null;
  providerType: string | null;
  promptVersion: string | null;
  updatedAt: string;
}

/**
 * Read the latest narrative for `(userId, period, locale)`, decrypting the
 * prose. Null when none was ever generated. This is the stale-while-revalidate
 * source: it returns whatever was last produced, regardless of age, so the
 * surface renders prior prose immediately while a refresh warms out of band.
 */
export async function readPeriodNarrative(
  userId: string,
  period: NarrativePeriod,
  locale: "de" | "en",
  prisma: PrismaClient = defaultPrisma,
): Promise<NarrativeRead | null> {
  const row = await prisma.insightNarrative.findUnique({
    where: { userId_period_locale: { userId, period, locale } },
  });
  if (!row) return null;

  let text: string;
  try {
    text = decryptFromBytes(row.encryptedContent);
  } catch {
    // A row we cannot decrypt is treated as absent — the caller regenerates.
    return null;
  }

  let provenance: NarrativeProvenancePayload | null = null;
  if (row.provenanceJson) {
    try {
      provenance = JSON.parse(row.provenanceJson) as NarrativeProvenancePayload;
    } catch {
      provenance = null;
    }
  }

  return {
    period: row.period as NarrativePeriod,
    locale: row.locale as "de" | "en",
    text,
    dateKey: row.dateKey,
    provenance,
    providerType: row.providerType,
    promptVersion: row.promptVersion,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ── helpers ───────────────────────────────────────────────────────────────

/** Prisma `Bytes` ↔ ciphertext, mirroring the CoachMessage helper. */
function encryptToBytes(plaintext: string): Uint8Array<ArrayBuffer> {
  const ciphertext = encrypt(plaintext);
  const encoded = Buffer.from(ciphertext, "utf8");
  const out = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  out.set(encoded);
  return out;
}

function decryptFromBytes(buf: Uint8Array): string {
  return decrypt(Buffer.from(buf).toString("utf8"));
}
