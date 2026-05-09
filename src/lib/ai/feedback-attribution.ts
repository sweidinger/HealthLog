/**
 * v1.4.16 phase B5e — server-side resolver for the provider/prompt
 * attribution that gets stamped on every `RecommendationFeedback` row.
 *
 * The client cannot supply these fields — that would let any user
 * poison the daily aggregator's slice (`(severity x provider x prompt)
 * helpful-rate`) by claiming a thumbs-down was attributed to a rival
 * provider. So the API endpoint reads the user's most recent
 * `insights.generate` audit row, pulls `chainProviderType` (or its
 * legacy fallback `providerType`) plus the current `PROMPT_VERSION`
 * constant, and stamps those on the row.
 *
 * If no audit row exists yet (the user is rating a per-status insight
 * that pre-dates the comprehensive generate flow), we fall back to
 * "unknown" + the current PROMPT_VERSION so the row is still
 * persistable and the aggregator can group "unknown" separately.
 */
import { prisma } from "@/lib/db";
import { PROMPT_VERSION } from "@/lib/ai/prompts/insight-generator";

export interface FeedbackAttribution {
  providerType: string;
  promptVersion: string;
}

/** Default attribution when no `insights.generate` row exists yet. */
export const FEEDBACK_ATTRIBUTION_FALLBACK: Readonly<FeedbackAttribution> = {
  providerType: "unknown",
  promptVersion: PROMPT_VERSION,
};

interface AuditDetailsShape {
  providerType?: unknown;
  chainProviderType?: unknown;
}

function parseAuditDetails(raw: string | null): AuditDetailsShape {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as AuditDetailsShape;
  } catch {
    // Treat unparseable details as absent — the fallback applies.
  }
  return {};
}

/**
 * Pure helper exported for unit tests so we can pin the priority order
 * (chainProviderType > providerType > "unknown") without hitting the
 * DB. The current PROMPT_VERSION constant is always returned because
 * the generator itself doesn't yet stash a per-payload prompt version
 * (research §3.B notes this is a v1.4.17 ratchet item; reading the
 * constant snapshots whatever's deployed when the rating fires).
 */
export function pickProviderType(details: AuditDetailsShape): string {
  if (typeof details.chainProviderType === "string") {
    return details.chainProviderType;
  }
  if (typeof details.providerType === "string") return details.providerType;
  return FEEDBACK_ATTRIBUTION_FALLBACK.providerType;
}

/**
 * Resolve the (providerType, promptVersion) tuple to stamp on a
 * `RecommendationFeedback` row. Reads the latest `insights.generate`
 * audit row for the user. Falls back to the safe defaults when no
 * audit row exists.
 */
export async function resolveFeedbackAttribution(
  userId: string,
): Promise<FeedbackAttribution> {
  const latest = await prisma.auditLog.findFirst({
    where: { userId, action: "insights.generate" },
    orderBy: { createdAt: "desc" },
    select: { details: true },
  });

  if (!latest) return { ...FEEDBACK_ATTRIBUTION_FALLBACK };

  const details = parseAuditDetails(latest.details);
  return {
    providerType: pickProviderType(details),
    promptVersion: PROMPT_VERSION,
  };
}
