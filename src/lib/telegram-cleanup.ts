/**
 * v1.19.0 — shared self-clean scheduling for the Telegram bot.
 *
 * The interactive mood + measurement flows ride the existing
 * `TelegramScheduledDeletion` table + the ~15-min pg-boss sweep
 * (`cleanupScheduledTelegramDeletions`). This helper centralises the
 * "schedule these message ids for deletion in ~30 minutes" write so the
 * webhook (free-text replies) and the sender (unanswered prompts) agree on
 * the window. The sweep deletes the bot's own prompt AND, where its id was
 * captured, the user's reply — both within Telegram's 48-hour window.
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";

/**
 * Auto-delete delay for interactive-flow prompts + answers. ~30 minutes
 * keeps the chat clean and unbiased while staying well inside Telegram's
 * 48-hour deletion ceiling. The sweep ticks every ~15 min, so real
 * deletion lands at 30–45 min — invisible slack, no dedicated queue.
 */
export const TELEGRAM_AUTO_DELETE_DELAY_MS = 30 * 60 * 1000;

/**
 * Schedule one or more Telegram message ids for best-effort deletion after
 * `TELEGRAM_AUTO_DELETE_DELAY_MS`. Best-effort: a write failure must never
 * break the inbound/outbound flow it rides on.
 */
export async function scheduleTelegramAutoDelete(
  userId: string,
  chatId: string,
  messageIds: number[],
  client: PrismaClient | Prisma.TransactionClient = defaultPrisma,
): Promise<void> {
  const ids = messageIds.filter((id): id is number => Number.isFinite(id));
  if (ids.length === 0) return;
  const deleteAfter = new Date(Date.now() + TELEGRAM_AUTO_DELETE_DELAY_MS);
  try {
    await client.telegramScheduledDeletion.createMany({
      data: ids.map((messageId) => ({
        userId,
        chatId,
        messageId,
        deleteAfter,
      })),
    });
  } catch {
    // Best-effort — the message simply lingers until the next send re-cleans.
  }
}
