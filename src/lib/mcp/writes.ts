/**
 * MCP write data cores — in-process measurement + mood logging.
 *
 * These mirror the proven server-authoritative Telegram capture helpers
 * (`src/lib/measurements/create-from-telegram.ts`,
 * `src/lib/mood/create-from-telegram.ts`) one-for-one — same range guard,
 * same canonical unit, same cache invalidation + rollup recompute — but pin
 * `source` to the dedicated `MCP` provenance and use an MCP idempotency
 * namespace. The two surfaces are kept as deliberate parallels rather than a
 * shared core so a future change to one cannot silently alter the other's
 * validation or dedup contract.
 *
 * `userId` is ALWAYS the resolved session id (`McpAuthContext.userId`), never
 * a caller-supplied field. The write tools (`src/lib/mcp/write-tools.ts`) own
 * the confirm gate; these cores only execute a confirmed write.
 */
import { createHash } from "node:crypto";

import type { MeasurementType } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { annotate, getEvent } from "@/lib/logging/context";
import {
  getUnitForType,
  validateMeasurementRange,
} from "@/lib/validations/measurement";
import { isTelegramCapturableType } from "@/lib/measurements/create-from-telegram";
import {
  invalidateUserMeasurements,
  invalidateUserMood,
} from "@/lib/cache/invalidate";
import { recomputeBucketsForMeasurement } from "@/lib/rollups/measurement-rollups";
import { recomputeMoodBucketsForEntry } from "@/lib/rollups/mood-rollups";
import { MOOD_ENUM_BY_SCORE } from "@/lib/mood/labels";
import { getScoreForMood } from "@/lib/validations/moodlog";
import { moodDateKey, DEFAULT_TIMEZONE } from "@/lib/mood/date-key";
import { pushMoodEntriesToMoodLog } from "@/lib/moodlog/push";

/** The MCP write provenance — distinct from MANUAL / TELEGRAM. */
const MCP_SOURCE = "MCP" as const;

/**
 * Derive the stable per-write `externalId` from the caller's idempotency key.
 * A SHA-256 hash keeps the column bounded and opaque regardless of how long
 * the assistant's key is, and gives the MCP writes their own dedup namespace
 * `(userId, type, MCP, externalId)` so a key can never collide with a
 * Telegram or manual row.
 */
function mcpExternalId(
  prefix: "measure" | "mood",
  idempotencyKey: string,
): string {
  const digest = createHash("sha256").update(idempotencyKey).digest("hex");
  return `mcp:${prefix}:${digest}`;
}

/** Normalized record echoed back to the assistant (preview + commit result). */
export interface McpMeasurementRecord {
  type: MeasurementType;
  value: number;
  unit: string;
  measuredAt: string;
  source: typeof MCP_SOURCE;
}

export type McpMeasurementResult =
  | { status: "unsupported_type" }
  | { status: "out_of_range"; reason: string }
  | { status: "written"; measurement: McpMeasurementRecord }
  | { status: "already_logged"; measurement: McpMeasurementRecord };

/**
 * Log one single-value measurement on behalf of the resolved MCP session.
 *
 * Mirrors `logTelegramMeasurement`: gates the type on the SAME
 * `isTelegramCapturableType` allowlist (the safe, user-loggable subset that
 * excludes COMPUTED / WHOOP / clinical-only types), validates the plausibility
 * range, and is idempotent on `(userId, type, MCP, externalId)`.
 */
export async function logMcpMeasurement(input: {
  userId: string;
  type: MeasurementType;
  value: number;
  unit?: string;
  measuredAt?: Date;
  idempotencyKey: string;
}): Promise<McpMeasurementResult> {
  if (!isTelegramCapturableType(input.type)) {
    annotate({
      action: { name: "mcp.tool.write" },
      meta: { tool: "log_measurement", status: "unsupported_type" },
    });
    return { status: "unsupported_type" };
  }

  const rangeError = validateMeasurementRange(input.type, input.value);
  if (rangeError !== null) {
    annotate({
      action: { name: "mcp.tool.write" },
      meta: { tool: "log_measurement", status: "out_of_range" },
    });
    return { status: "out_of_range", reason: rangeError };
  }

  const unit = input.unit ?? getUnitForType(input.type);
  const measuredAt = input.measuredAt ?? new Date();
  const externalId = mcpExternalId("measure", input.idempotencyKey);

  const record: McpMeasurementRecord = {
    type: input.type,
    value: input.value,
    unit,
    measuredAt: measuredAt.toISOString(),
    source: MCP_SOURCE,
  };

  const existing = await prisma.measurement.findUnique({
    where: {
      userId_type_source_externalId: {
        userId: input.userId,
        type: input.type,
        source: MCP_SOURCE,
        externalId,
      },
    },
    select: { id: true, value: true, unit: true, measuredAt: true },
  });
  if (existing) {
    annotate({
      action: { name: "mcp.tool.write" },
      meta: { tool: "log_measurement", status: "already_logged" },
    });
    return {
      status: "already_logged",
      measurement: {
        type: input.type,
        value: existing.value,
        unit: existing.unit ?? unit,
        measuredAt: existing.measuredAt.toISOString(),
        source: MCP_SOURCE,
      },
    };
  }

  // No mass assignment — every column is set explicitly from validated input.
  await prisma.measurement.create({
    data: {
      userId: input.userId,
      type: input.type,
      value: input.value,
      unit,
      source: MCP_SOURCE,
      measuredAt,
      externalId,
    },
  });

  invalidateUserMeasurements(input.userId, { evict: true });

  // Best-effort rollup refresh — a cache tier, never a write-path invariant.
  try {
    await recomputeBucketsForMeasurement(input.userId, input.type, measuredAt);
  } catch (rollupErr) {
    getEvent()?.addMeta(
      "mcp_measurement_rollup_failed",
      rollupErr instanceof Error ? rollupErr.message : String(rollupErr),
    );
  }

  await auditLog("mcp.write.measurement", {
    userId: input.userId,
    details: {
      type: input.type,
      source: MCP_SOURCE,
      idempotencyKey: input.idempotencyKey,
    },
  });
  annotate({
    action: { name: "mcp.tool.write" },
    meta: { tool: "log_measurement", status: "written" },
  });

  return { status: "written", measurement: record };
}

/** Normalized mood record echoed back to the assistant. */
export interface McpMoodRecord {
  score: number;
  mood: string;
  note: string | null;
  date: string;
  source: typeof MCP_SOURCE;
}

export type McpMoodResult =
  | { status: "invalid_score" }
  | { status: "written"; moodEntry: McpMoodRecord }
  | { status: "already_logged"; moodEntry: McpMoodRecord };

/**
 * Log one mood entry on behalf of the resolved MCP session.
 *
 * Mirrors `logTelegramMood`: maps the 1..5 score to the canonical mood enum,
 * anchors the date key in the user's timezone, and is idempotent on the
 * NULL-distinct `(userId, source, externalId)` unique with `source = "MCP"`.
 */
export async function logMcpMood(input: {
  userId: string;
  score: number;
  note?: string | null;
  tz?: string | null;
  idempotencyKey: string;
}): Promise<McpMoodResult> {
  const mood = MOOD_ENUM_BY_SCORE[input.score];
  if (!mood) {
    annotate({
      action: { name: "mcp.tool.write" },
      meta: { tool: "log_mood", status: "invalid_score" },
    });
    return { status: "invalid_score" };
  }

  const score = getScoreForMood(mood);
  const note = input.note ? input.note.slice(0, 500) : null;
  const moodLoggedAt = new Date();
  const tz = input.tz ?? DEFAULT_TIMEZONE;
  const date = moodDateKey(moodLoggedAt, tz);
  const externalId = mcpExternalId("mood", input.idempotencyKey);

  const existing = await prisma.moodEntry.findUnique({
    where: {
      userId_source_externalId: {
        userId: input.userId,
        source: MCP_SOURCE,
        externalId,
      },
    },
    select: { mood: true, score: true, note: true, date: true },
  });
  if (existing) {
    annotate({
      action: { name: "mcp.tool.write" },
      meta: { tool: "log_mood", status: "already_logged" },
    });
    return {
      status: "already_logged",
      moodEntry: {
        score: existing.score,
        mood: existing.mood,
        note: existing.note ?? null,
        date: existing.date,
        source: MCP_SOURCE,
      },
    };
  }

  // No mass assignment — every column is set explicitly from validated input.
  const entry = await prisma.moodEntry.create({
    data: {
      userId: input.userId,
      date,
      tz,
      mood,
      score,
      note,
      source: MCP_SOURCE,
      externalId,
      moodLoggedAt,
    },
    select: { date: true, mood: true, note: true, tags: true },
  });

  invalidateUserMood(input.userId);

  // Best-effort rollup refresh — a cache tier, never a write-path invariant.
  try {
    await recomputeMoodBucketsForEntry(input.userId, moodLoggedAt);
  } catch (rollupErr) {
    getEvent()?.addMeta(
      "mcp_mood_rollup_failed",
      rollupErr instanceof Error ? rollupErr.message : String(rollupErr),
    );
  }

  // Reverse-sync to MoodLog (fire-and-forget; never throws).
  void pushMoodEntriesToMoodLog(input.userId, [
    {
      date: entry.date,
      moodLoggedAt,
      mood: entry.mood,
      note: entry.note ?? null,
      tags: entry.tags,
      source: MCP_SOURCE,
    },
  ]).catch(() => {});

  await auditLog("mcp.write.mood", {
    userId: input.userId,
    details: { source: MCP_SOURCE, idempotencyKey: input.idempotencyKey },
  });
  annotate({
    action: { name: "mcp.tool.write" },
    meta: { tool: "log_mood", status: "written" },
  });

  return {
    status: "written",
    moodEntry: {
      score,
      mood: entry.mood,
      note: entry.note ?? null,
      date: entry.date,
      source: MCP_SOURCE,
    },
  };
}
