/**
 * v1.16.0 — clarifying questions for the self-context questionnaire.
 *
 * After the user saves Settings → AI → "About me", the server derives
 * up to 3 short follow-up questions that would best complete the
 * picture for the Coach, and persists them encrypted
 * (`UserHealthProfile.pendingQuestionsEncrypted`). The Coach composer
 * renders them as tappable suggestion chips; answering or dismissing a
 * chip removes it.
 *
 * Two paths, gated in order:
 *   1. AI path — only when the user has a working provider
 *      (`hasAnyConfiguredProvider`) AND the daily Coach token budget
 *      is not exhausted. One single-shot completion (no fallback
 *      chain — this is a nicety, not a core flow); spend is recorded
 *      against the same per-day ledger the Coach uses.
 *   2. Deterministic path — two static completion hints for the first
 *      two unanswered fields, localised through the server translator.
 *      Also the landing spot for every AI-path failure (no provider,
 *      budget gone, model error, unparseable output).
 *
 * Server-only — reads `@/lib/db` through the provider resolver.
 */
import {
  hasAnyConfiguredProvider,
  resolveProvider,
} from "@/lib/ai/provider";
import {
  buildDateKey,
  getDailyTokenSpend,
  MAX_TOKENS_PER_USER_PER_DAY,
  recordSpend,
} from "@/lib/ai/coach/budget";
import {
  clampPendingQuestions,
  type SelfContext,
} from "@/lib/ai/coach/about-me";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import type { Locale } from "@/lib/i18n/config";
import { defaultLocale, locales } from "@/lib/i18n/config";
import { annotate } from "@/lib/logging/context";

/** Token ceiling for the single-shot questions completion. */
const QUESTIONS_MAX_TOKENS = 300;

const LANGUAGE_NAMES: Record<Locale, string> = {
  de: "German",
  en: "English",
  es: "Spanish",
  fr: "French",
  it: "Italian",
  pl: "Polish",
};

function resolveLocale(locale: string | null | undefined): Locale {
  return locales.includes(locale as Locale)
    ? (locale as Locale)
    : defaultLocale;
}

/**
 * Deterministic fallback: completion hints for the first two unanswered
 * fields, in a fixed priority order (conditions → focus → allergies →
 * free text). Fully answered questionnaires get no hints — there is
 * nothing left to complete.
 */
export function buildFallbackQuestions(
  ctx: SelfContext,
  locale: string | null | undefined,
): string[] {
  const t = getServerTranslator(resolveLocale(locale)).t;
  const hints: string[] = [];
  if (!ctx.conditions) hints.push(t("coachNudges.questionConditions"));
  if (!ctx.coachFocus) hints.push(t("coachNudges.questionFocus"));
  if (!ctx.allergies) hints.push(t("coachNudges.questionAllergies"));
  if (!ctx.aboutMe) hints.push(t("coachNudges.questionAboutMe"));
  return hints.slice(0, 2);
}

/**
 * Extract a string[] from a model reply that should be a JSON array.
 * Tolerates code fences and prose around the array; everything else
 * yields `[]` so the caller falls back deterministically.
 */
export function parseQuestionsReply(content: string): string[] {
  const start = content.indexOf("[");
  const end = content.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    return clampPendingQuestions(JSON.parse(content.slice(start, end + 1)));
  } catch {
    return [];
  }
}

function buildPrompts(
  ctx: SelfContext,
  locale: Locale,
): { systemPrompt: string; userPrompt: string } {
  const language = LANGUAGE_NAMES[locale];
  const systemPrompt = `You help complete a health-app user's self-description for their AI health coach. Based on what the user has already shared, write AT MOST 3 short, specific follow-up questions that would best complete the picture (e.g. unstated conditions a stated medication implies, missing context for a stated goal). Never ask for anything already answered. Never ask for a diagnosis. Write the questions in ${language}, addressed informally to the user. Reply with ONLY a JSON array of strings — no prose, no code fences.`;

  const fieldLines = [
    `conditions: ${ctx.conditions ?? "(not answered)"}`,
    `allergies/intolerances: ${ctx.allergies ?? "(not answered)"}`,
    `coach focus: ${ctx.coachFocus ?? "(not answered)"}`,
    `free text: ${ctx.aboutMe ?? "(not answered)"}`,
  ];
  return { systemPrompt, userPrompt: fieldLines.join("\n") };
}

/**
 * Derive the pending questions for a freshly saved self-context.
 * Never throws — every failure path lands on the deterministic
 * fallback so the PUT route stays robust.
 */
export async function deriveClarifyingQuestions(
  userId: string,
  ctx: SelfContext,
  locale: string | null | undefined,
): Promise<{ questions: string[]; source: "ai" | "fallback" }> {
  const fallback = () => ({
    questions: buildFallbackQuestions(ctx, locale),
    source: "fallback" as const,
  });

  try {
    if (!(await hasAnyConfiguredProvider(userId))) return fallback();

    // Budget gate — same per-day ledger the Coach chat enforces.
    const dateKey = buildDateKey();
    const spent = await getDailyTokenSpend(userId, dateKey);
    if (spent >= MAX_TOKENS_PER_USER_PER_DAY) return fallback();

    const provider = await resolveProvider(userId);
    const { systemPrompt, userPrompt } = buildPrompts(
      ctx,
      resolveLocale(locale),
    );
    const result = await provider.generateCompletion({
      systemPrompt,
      userPrompt,
      temperature: 0.4,
      maxTokens: QUESTIONS_MAX_TOKENS,
    });
    if (typeof result.tokensUsed === "number" && result.tokensUsed > 0) {
      await recordSpend({ userId, tokens: result.tokensUsed, dateKey });
    }

    const questions = parseQuestionsReply(result.content);
    if (questions.length === 0) return fallback();

    annotate({
      meta: {
        self_context_questions_source: "ai",
        self_context_questions_count: questions.length,
      },
    });
    return { questions, source: "ai" };
  } catch {
    return fallback();
  }
}
