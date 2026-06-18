/**
 * Rest Mode — the server-authoritative "an episode is active" context (v1.18.1, P4).
 *
 * CORE PRINCIPLE: an active illness/condition episode ANNOTATES, it never
 * PENALISES. Rest Mode never changes a measured number — it only frames the
 * narrative around it: the health score keeps its value but carries a "you
 * were unwell" note, recovery keeps its number, achievement streaks freeze
 * (rather than break) across the days you were ill, cadence-nudges pause, and
 * a coincident vital deviation reads as illness-explained instead of an
 * unexplained anomaly.
 *
 * This module is the ONE place that resolves "is the account in Rest Mode
 * right now, and which episodes back it" — so every surface annotates from
 * the same fact. It is server-authoritative: the resolved `RestModeContext`
 * is the DTO the iOS client mirrors (it renders Rest Mode, never recomputes
 * the suppression). The illness module gate is honoured: a disabled / opted-
 * out account is never in Rest Mode (the gate short-circuits before any read).
 *
 * "Active" = an `IllnessEpisode` with `resolvedAt = null` (still ongoing),
 * not soft-deleted, whose `onsetAt` is on or before the reference instant.
 * CHRONIC_ONGOING episodes are intentionally INCLUDED here — an ongoing
 * chronic condition is precisely the case where a measured dip should be
 * framed, not penalised. (They are excluded only from the recovery-GAP math,
 * which is P3 and lives elsewhere.)
 */
import type { PrismaClient, IllnessEpisode } from "@/generated/prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { isIllnessEnabled } from "@/lib/illness/gate";
import { memoizePerRequest } from "@/lib/request-cache";

/** Minimal shape the Rest Mode resolver needs from an episode row. */
export type ActiveIllnessEpisode = Pick<
  IllnessEpisode,
  "id" | "label" | "type" | "lifecycle" | "onsetAt"
>;

/**
 * The resolved Rest Mode annotation a surface attaches to its result. Carries
 * NO measured value — it is pure narrative context. `active` is the single
 * flag a renderer branches on; `since` is the earliest active onset (the
 * "unwell since" anchor); `episodes` is the small set backing it (label +
 * type only — no decrypted note, no free-text leaks into a score payload).
 *
 * This is the server-authoritative shape iOS mirrors verbatim.
 */
export interface RestModeContext {
  /** True when ≥ 1 illness episode is active as of the reference instant. */
  active: boolean;
  /** ISO onset of the earliest active episode, or null when none. */
  since: string | null;
  /** Count of active episodes (usually 1; ≥ 2 when conditions overlap). */
  episodeCount: number;
  /** The active episodes, label + type + onset only — never a decrypted note. */
  episodes: Array<{
    id: string;
    label: string;
    type: string;
    lifecycle: string;
    onsetAt: string;
  }>;
}

/** The neutral, honest empty state — not in Rest Mode. */
export const REST_MODE_INACTIVE: RestModeContext = {
  active: false,
  since: null,
  episodeCount: 0,
  episodes: [],
};

/**
 * Read the active illness episodes for an account as of `asOf`. Gated through
 * the illness module: a disabled / not-opted-in account returns `[]` without
 * touching the episode table. The reference instant is injectable so the
 * resolver is deterministic for tests and so a nightly job can resolve "as of
 * the scored day".
 */
export async function getActiveIllnessEpisodes(
  userId: string,
  asOf: Date = new Date(),
  client: PrismaClient = defaultPrisma,
): Promise<ActiveIllnessEpisode[]> {
  // Several surfaces resolve Rest Mode for the same `(userId, asOf)` inside
  // one request — the snapshot builder, the recovery score it builds, the
  // analytics route, and coincident-deviation — each firing an identical
  // `findMany`. Dedupe them to a single read per request. An explicit client
  // (a test stub or a transaction) bypasses the memo so its query is never
  // served a default-client cached result.
  if (client !== defaultPrisma) return readActiveIllnessEpisodes(userId, asOf, client);
  return memoizePerRequest(
    `illness-active-episodes:${userId}:${asOf.getTime()}`,
    () => readActiveIllnessEpisodes(userId, asOf, client),
  );
}

async function readActiveIllnessEpisodes(
  userId: string,
  asOf: Date,
  client: PrismaClient,
): Promise<ActiveIllnessEpisode[]> {
  if (!(await isIllnessEnabled(userId))) return [];
  return client.illnessEpisode.findMany({
    where: {
      userId,
      deletedAt: null,
      resolvedAt: null,
      onsetAt: { lte: asOf },
    },
    select: {
      id: true,
      label: true,
      type: true,
      lifecycle: true,
      onsetAt: true,
    },
    orderBy: { onsetAt: "asc" },
  });
}

/** Fold a set of active episodes into the renderable Rest Mode context. Pure. */
export function toRestModeContext(
  episodes: ActiveIllnessEpisode[],
): RestModeContext {
  if (episodes.length === 0) return REST_MODE_INACTIVE;
  return {
    active: true,
    since: episodes[0].onsetAt.toISOString(),
    episodeCount: episodes.length,
    episodes: episodes.map((e) => ({
      id: e.id,
      label: e.label,
      type: e.type,
      lifecycle: e.lifecycle,
      onsetAt: e.onsetAt.toISOString(),
    })),
  };
}

/**
 * Resolve the Rest Mode context for an account as of `asOf` — the one call a
 * surface makes to learn whether to annotate. Module-gated and fail-soft: any
 * resolution error reads as "not in Rest Mode" so a Rest Mode read can never
 * break the score / recovery / achievements payload it annotates.
 */
export async function resolveRestMode(
  userId: string,
  asOf: Date = new Date(),
  client: PrismaClient = defaultPrisma,
): Promise<RestModeContext> {
  try {
    const episodes = await getActiveIllnessEpisodes(userId, asOf, client);
    return toRestModeContext(episodes);
  } catch {
    return REST_MODE_INACTIVE;
  }
}
