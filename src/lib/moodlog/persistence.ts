import { prisma } from "@/lib/db";
import { isP2002 } from "@/lib/prisma-errors";

export interface MoodLogSourceEntry {
  externalId: string | null;
  date: string;
  moodLoggedAt: Date;
  mood: string;
  score: number;
  tags?: readonly string[];
}

/**
 * Persist one moodLog-owned source row using the provider id when available
 * and the legacy wall-clock key otherwise.
 *
 * A provider may add an id after an older delivery already created the row by
 * wall-clock key. In that case the external-id upsert collides with the legacy
 * unique constraint; adopt that durable row and attach the provider id rather
 * than creating a duplicate or retrying forever.
 */
export async function persistMoodLogSourceEntry(
  userId: string,
  entry: MoodLogSourceEntry,
): Promise<void> {
  const tags = entry.tags ? JSON.stringify(entry.tags) : null;
  const update = {
    mood: entry.mood,
    score: entry.score,
    tags,
    source: "MOODLOG",
    deletedAt: null,
  } as const;

  if (!entry.externalId) {
    await prisma.moodEntry.upsert({
      where: {
        userId_date_moodLoggedAt: {
          userId,
          date: entry.date,
          moodLoggedAt: entry.moodLoggedAt,
        },
      },
      update,
      create: {
        userId,
        date: entry.date,
        moodLoggedAt: entry.moodLoggedAt,
        ...update,
      },
    });
    return;
  }

  let collisionError: unknown;
  try {
    await prisma.moodEntry.upsert({
      where: {
        userId_source_externalId: {
          userId,
          source: "MOODLOG",
          externalId: entry.externalId,
        },
      },
      update: {
        ...update,
        date: entry.date,
        moodLoggedAt: entry.moodLoggedAt,
      },
      create: {
        userId,
        date: entry.date,
        moodLoggedAt: entry.moodLoggedAt,
        externalId: entry.externalId,
        ...update,
      },
    });
    return;
  } catch (err) {
    if (!isP2002(err)) throw err;
    collisionError = err;
  }

  const adopted = await prisma.moodEntry.updateMany({
    where: {
      userId,
      date: entry.date,
      moodLoggedAt: entry.moodLoggedAt,
      source: "MOODLOG",
      externalId: null,
    },
    data: {
      ...update,
      externalId: entry.externalId,
    },
  });
  if (adopted.count === 1) return;

  // A concurrent replay may have adopted the same legacy row first.
  const winner = await prisma.moodEntry.findUnique({
    where: {
      userId_source_externalId: {
        userId,
        source: "MOODLOG",
        externalId: entry.externalId,
      },
    },
    select: { date: true, moodLoggedAt: true },
  });
  if (
    winner?.date === entry.date &&
    winner.moodLoggedAt.getTime() === entry.moodLoggedAt.getTime()
  ) {
    await prisma.moodEntry.update({
      where: {
        userId_source_externalId: {
          userId,
          source: "MOODLOG",
          externalId: entry.externalId,
        },
      },
      data: {
        ...update,
        date: entry.date,
        moodLoggedAt: entry.moodLoggedAt,
      },
    });
    return;
  }

  throw collisionError;
}
