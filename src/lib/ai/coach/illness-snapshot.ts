/**
 * v1.18.1 P4 — illness / condition context block for the Coach snapshot.
 *
 * Gives the Coach the FACT that the user has (or recently had) a condition so
 * its replies are grounded: it should not push a "measure more often" cadence
 * at someone who is unwell, and it should read a low recovery / off-band vital
 * as illness-explained rather than alarming. This is CONTEXT, not a metric —
 * the block carries no measured number, only labels + lifecycle + dates (never
 * the decrypted free-text note, which must not reach the prompt).
 *
 * Server-authoritative and module-gated: a non-illness / opted-out account
 * gets `null` (no block, no read). The active set drives the `restMode` flag
 * the Coach reads; a short resolved-history tail lets it answer "how often do
 * I get sick" without re-deriving anything.
 */
import { prisma } from "@/lib/db";
import { isIllnessEnabled } from "@/lib/illness/gate";

/** How many recently-resolved episodes to include as history context. */
const RESOLVED_HISTORY_LIMIT = 6;

/** Max characters of the user free-text label that may enter the prompt. */
const MAX_LABEL_CHARS = 80;

/**
 * Cap + strip the user-supplied free-text episode label before it enters the
 * Coach LLM prompt. The label is the one user-controlled string in this block,
 * so it is a (self-scoped) prompt-injection surface: collapse control chars +
 * newlines to spaces so an embedded "ignore previous instructions\n..." can't
 * reshape the prompt structure, and bound the length.
 */
export function sanitizeLabel(label: string): string {
  // Replace every C0/C1 control char (incl. newlines) with a space, collapse
  // runs of whitespace, trim, then bound the length.
  let out = "";
  for (const ch of label) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_CHARS);
}

export interface CoachIllnessBlock {
  /** True when ≥ 1 episode is active right now (the Rest Mode flag). */
  restMode: boolean;
  /** Active (unresolved) episodes — the Coach frames its reply around these. */
  active: Array<{
    label: string;
    type: string;
    lifecycle: string;
    onsetAt: string;
  }>;
  /** Recently-resolved episodes, newest first — light history context. */
  recentResolved: Array<{
    label: string;
    type: string;
    onsetAt: string;
    resolvedAt: string;
  }>;
}

/**
 * Build the illness context block, or `null` when the module is off / the
 * account has no episode history. Reads label + lifecycle + dates only — the
 * `noteEncrypted` column is never selected.
 */
export async function buildIllnessSnapshotBlock(
  userId: string,
  now: Date = new Date(),
): Promise<CoachIllnessBlock | null> {
  if (!(await isIllnessEnabled(userId))) return null;

  const [activeRows, resolvedRows] = await Promise.all([
    prisma.illnessEpisode.findMany({
      where: {
        userId,
        deletedAt: null,
        resolvedAt: null,
        onsetAt: { lte: now },
      },
      orderBy: { onsetAt: "asc" },
      select: { label: true, type: true, lifecycle: true, onsetAt: true },
    }),
    prisma.illnessEpisode.findMany({
      where: { userId, deletedAt: null, resolvedAt: { not: null } },
      orderBy: { resolvedAt: "desc" },
      take: RESOLVED_HISTORY_LIMIT,
      select: { label: true, type: true, onsetAt: true, resolvedAt: true },
    }),
  ]);

  if (activeRows.length === 0 && resolvedRows.length === 0) return null;

  return {
    restMode: activeRows.length > 0,
    active: activeRows.map((e) => ({
      label: sanitizeLabel(e.label),
      type: e.type,
      lifecycle: e.lifecycle,
      onsetAt: e.onsetAt.toISOString(),
    })),
    recentResolved: resolvedRows.map((e) => ({
      label: sanitizeLabel(e.label),
      type: e.type,
      onsetAt: e.onsetAt.toISOString(),
      // `resolvedAt` is non-null by the query filter above.
      resolvedAt: (e.resolvedAt as Date).toISOString(),
    })),
  };
}
