/**
 * The `reaction-line-generate` worker — the day's single sentence about what
 * just landed.
 *
 * This is the ONE provider call the arrival spine can cause, and the whole
 * design of the surface is arranged so that call is bounded before it is made:
 *
 *   - The THROTTLE is a durable unique row, not a timer. The spine enqueues
 *     this only on the pass that freshly INSERTED today's `ArrivalReaction`
 *     for the kind (`data-arrival.ts`, the `claimed` branch), and this worker
 *     re-checks `generatedAt` before spending anything. Both ends of that
 *     claim are the same `@@unique([userId, kind, localDate])` constraint, so
 *     there is no code path to a second call for a kind on a day — not a
 *     racing spine job, not a retry, not a hand-sent job.
 *   - The SPEND is reserved before the call and reconciled on EVERY exit,
 *     including each failure path. A provider that times out still burned
 *     upstream tokens; a reservation that is never reconciled is a silent
 *     over-charge against the user's own daily ceiling.
 *   - The FLOOR is complete without any of this. No provider, no consent, an
 *     exhausted budget, a refused output, a dead network — every one of them
 *     leaves the row line-less, and a line-less row still drives the "just in"
 *     chip and the provisional→final flip. The reaction is a state change; the
 *     sentence is garnish. `reaction-line-degradation.test.ts` holds that line.
 *
 * The grounding is deliberately the digest itself: it is already cached,
 * already deterministic, already the thing the surface will render the line
 * next to, and reading it costs no new query path. A line grounded in a
 * DIFFERENT snapshot than the one on screen is how a surface starts
 * contradicting itself.
 */
import type { Job } from "pg-boss";

import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { withBackgroundEvent } from "@/lib/logging/background";
import { resolveProviderChain } from "@/lib/ai/provider";
import {
  chainRequiresServerManagedConsent,
  hasActiveConsentForSurface,
} from "@/lib/ai/consent-guard";
import {
  buildDateKey,
  reconcileSpend,
  reserveBudget,
  resolveDailyCap,
} from "@/lib/ai/coach/budget";
import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import { singleUserTurn } from "@/lib/ai/types";
import { screenCoachReply } from "@/lib/ai/coach/outbound-guard";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { defaultLocale, locales, type Locale } from "@/lib/i18n/config";
import { loadDailyDigest } from "@/lib/daily/load-digest";
import {
  getArrivalReactionSystemPrompt,
  getArrivalReactionUserPrompt,
} from "@/lib/ai/prompts/arrival-reaction";
import {
  REACTION_LINE_QUEUE,
  type ReactionLineJob,
} from "@/lib/arrivals/reaction-line-shared";

import { workerLog } from "./reminder/shared";

export { REACTION_LINE_QUEUE };

/** Upstream timeout. A hero line is not worth holding a worker slot for long. */
export const REACTION_LINE_TIMEOUT_MS = 12_000;

/**
 * Hard ceiling on a shippable line. The contract asks for one sentence; a
 * model that returns a paragraph has not followed it, and clamping mid-thought
 * would ship a truncated verdict. Reject and keep the deterministic lead.
 */
export const REACTION_LINE_MAX_CHARS = 240;

/**
 * Tokens reserved per call.
 *
 * Sized to the whole call, not the output ceiling: the base assessment system
 * prompt plus a compact evidence block plus the 220-token output. Reserving
 * only the output would let a day's reactions spend materially more than they
 * booked against the user's daily cap — the reconcile corrects the number
 * afterwards, but the CAP check happens at reservation time.
 */
export const ARRIVAL_REACTION_RESERVE_TOKENS = 1_400;

export type ReactionLineOutcome =
  { status: "skipped"; reason: string } | { status: "generated" };

function resolveLocale(locale: string | null | undefined): Locale {
  return locales.includes(locale as Locale)
    ? (locale as Locale)
    : defaultLocale;
}

/**
 * Normalise the model's output into a shippable sentence, or null.
 *
 * Rejects rather than repairs: a line that broke the shape broke the contract,
 * and the deterministic lead it would replace is already good.
 */
export function sanitiseReactionLine(
  raw: string,
  locale: Locale,
): string | null {
  let text = (raw ?? "").trim();
  if (!text) return null;
  text = text
    .replace(/^["“”'`]+/, "")
    .replace(/["“”'`]+$/, "")
    .trim()
    .replace(/\s+/g, " ");
  if (!text) return null;
  if (text.length > REACTION_LINE_MAX_CHARS) return null;
  // The same outbound content fence the Coach reply path runs — a dose
  // prescription or a fabricated risk score never reaches the hero.
  if (screenCoachReply(text, locale).block) return null;
  return text;
}

/**
 * The deterministic evidence block. Built from the ALREADY-COMPUTED digest —
 * no figure here is derived in this module, which is what keeps the line
 * grounded in the same numbers the surface is rendering.
 */
function buildEvidence(digest: {
  score: { value: number; band: string; delta: number | null } | null;
  topSignal: { headline: string; delta: string | null } | null;
  briefingLead: string | null;
}): string {
  const parts: string[] = [];
  if (digest.score) {
    const delta =
      digest.score.delta === null
        ? "no baseline comparison available"
        : `${digest.score.delta > 0 ? "+" : ""}${Math.round(digest.score.delta)} vs their baseline`;
    parts.push(
      `- Health score: ${Math.round(digest.score.value)} (${digest.score.band}), ${delta}.`,
    );
  }
  if (digest.topSignal) {
    parts.push(
      `- Today's leading signal: ${digest.topSignal.headline}${
        digest.topSignal.delta ? ` (${digest.topSignal.delta})` : ""
      }.`,
    );
  }
  if (digest.briefingLead) {
    parts.push(`- The day's standing read: ${digest.briefingLead}`);
  }
  return parts.length > 0
    ? parts.join("\n")
    : "- (No computed comparison is available for this person yet.)";
}

/**
 * Generate and persist one reaction line.
 *
 * Every refusal RETURNS a status rather than throwing — the discipline the
 * spine's worker documents at length. A ceiling that does not move until the
 * local day rolls over must never be retried against.
 */
export async function runReactionLine(
  job: ReactionLineJob,
): Promise<ReactionLineOutcome> {
  const row = await prisma.arrivalReaction.findUnique({
    where: {
      userId_kind_localDate: {
        userId: job.userId,
        kind: job.kind,
        localDate: job.localDate,
      },
    },
    select: { id: true, generatedAt: true },
  });

  // The marker is gone (retention swept it, or the account was deleted) or a
  // line already committed. Either way there is nothing left to write, and the
  // unique row having a `generatedAt` IS the once-per-kind-per-day claim.
  if (!row) return { status: "skipped", reason: "no_marker" };
  if (row.generatedAt !== null) {
    return { status: "skipped", reason: "already_generated" };
  }

  // The whole row: the locale decides the prompt, and `loadDailyDigest` takes
  // a `User` (it reads the timezone and the morning-refresh marker off it), so
  // one read serves both rather than two.
  const user = await prisma.user.findUnique({ where: { id: job.userId } });
  if (!user) return { status: "skipped", reason: "no_user" };

  const locale = resolveLocale(user.locale);

  const chain = await resolveProviderChain(job.userId);
  // A provider-less install is the DEFAULT self-hosted shape, not an error.
  if (chain.length === 0) return { status: "skipped", reason: "no_provider" };

  // Consent gate before the reservation, so a user without a receipt never
  // spends a token. This tick is unattended, so it carries the same receipt
  // requirement as the interactive surfaces. BYOK / local / ChatGPT-OAuth
  // chains are the user's own egress and stay ungated.
  if (
    chainRequiresServerManagedConsent(chain) &&
    !(await hasActiveConsentForSurface(job.userId, "insights"))
  ) {
    return { status: "skipped", reason: "consent_required" };
  }

  const budget = AI_BUDGETS.arrivalReaction;
  const maxTokens = budget.maxTokens ?? 220;
  const dateKey = buildDateKey();
  const reservation = await reserveBudget(
    job.userId,
    // Reserve the documented ceiling for this surface, not the output cap
    // alone: the reservation has to cover the prompt the call actually sends,
    // or a day of these under-reports its own spend against the user's cap.
    ARRIVAL_REACTION_RESERVE_TOKENS,
    dateKey,
    resolveDailyCap(chain),
  );
  if (!reservation.allowed) {
    return { status: "skipped", reason: "budget_exceeded" };
  }

  // From here every exit MUST reconcile — the reservation is already on the
  // user's ledger.
  let line: string | null = null;
  try {
    // The digest is the grounding AND the thing the line will sit inside.
    const digest = await loadDailyDigest(user);

    const result = await chain[0].instance.generateCompletion(
      singleUserTurn({
        system: getArrivalReactionSystemPrompt(locale),
        user: getArrivalReactionUserPrompt({
          kind: job.kind,
          evidence: buildEvidence(digest),
        }),
        temperature: budget.temperature,
        maxTokens,
        timeoutMs: REACTION_LINE_TIMEOUT_MS,
        signal: AbortSignal.timeout(REACTION_LINE_TIMEOUT_MS + 1_000),
      }),
    );

    await reconcileSpend(
      job.userId,
      reservation.reserved,
      result.tokensUsed ?? 0,
      dateKey,
      result.cachedInputTokens ?? 0,
    ).catch(() => {});

    line = sanitiseReactionLine(result.content, locale);
  } catch (err) {
    // Timeout / network / provider / grounding failure. Reconcile against a
    // zero actual so the unspent reservation is returned, then degrade.
    await reconcileSpend(job.userId, reservation.reserved, 0, dateKey).catch(
      () => {},
    );
    workerLog("error", "[reaction-line] generation failed", err);
    return { status: "skipped", reason: "provider_failed" };
  }

  if (!line) return { status: "skipped", reason: "unusable_output" };

  // Commit. `generatedAt` and the ciphertext land together and are read
  // together (`load-digest.ts` requires both), so a half-written row can never
  // surface a line.
  await prisma.arrivalReaction.update({
    where: { id: row.id },
    data: { lineEncrypted: encryptToBytes(line), generatedAt: new Date() },
  });

  return { status: "generated" };
}

export async function handleReactionLine(
  jobs: Job<ReactionLineJob>[],
): Promise<void> {
  await withBackgroundEvent("job.reaction_line", async (evt) => {
    for (const job of jobs) {
      try {
        const outcome = await runReactionLine(job.data);

        if (outcome.status === "skipped") {
          annotate({
            action: { name: "arrival.reaction_line.skipped" },
            meta: { reason: outcome.reason, kind: job.data.kind },
          });
          evt.addMeta("reaction_line", `skipped:${outcome.reason}`);
          continue;
        }

        annotate({
          action: { name: "arrival.reaction_line.generated" },
          meta: { kind: job.data.kind, local_date: job.data.localDate },
        });
        evt.addMeta("reaction_line", "generated");
      } catch (err) {
        // Only a genuine transient fault reaches here — every business refusal
        // returned a status. Let the queue's single retry apply; the
        // `generatedAt` check makes the retry idempotent.
        workerLog("error", "[reaction-line] pass failed", err);
        throw err;
      }
    }
  });
}
