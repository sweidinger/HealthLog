/**
 * Attribute a day-log date to its owning `MenstrualCycle` span.
 *
 * A day-log belongs to the cycle whose `startDate <= date` and which is
 * the latest such start (the cycle is open-ended until the next cycle's
 * start). Returns the cycle id or null when no cycle precedes the date.
 */
import { prisma } from "@/lib/db";

export async function findOwningCycleId(
  userId: string,
  date: string,
): Promise<string | null> {
  const cycle = await prisma.menstrualCycle.findFirst({
    where: {
      userId,
      deletedAt: null,
      startDate: { lte: date },
    },
    orderBy: { startDate: "desc" },
    select: { id: true },
  });
  return cycle?.id ?? null;
}
