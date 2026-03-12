import { prisma } from "@/lib/db";
import { apiSuccess, apiError } from "@/lib/api-response";
import { decrypt } from "@/lib/crypto";
import { sendTelegramMessage } from "@/lib/telegram";
import { checkRateLimit } from "@/lib/rate-limit";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";

/**
 * Send a test Telegram message to verify the bot token and chat ID.
 */
export const POST = apiHandler(async () => {
  const { user } = await requireAuth();

  const rl = await checkRateLimit(`telegram-test:${user.id}`, 5, 5 * 60 * 1000);
  if (!rl.allowed) {
    return apiError("Maximum 5 tests in 5 minutes", 429);
  }

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: { telegramBotToken: true, telegramChatId: true },
  });

  if (!dbUser?.telegramBotToken || !dbUser?.telegramChatId) {
    return apiError(
      "Bot token and chat ID must be saved first",
      422,
    );
  }

  const botToken = decrypt(dbUser.telegramBotToken);
  const ok = await sendTelegramMessage(
    botToken,
    dbUser.telegramChatId,
    "HealthLog: Connection successful! Telegram notifications are active.",
  );

  if (!ok) {
    return apiError(
      "Failed to send message. Check bot token and chat ID.",
      422,
    );
  }

  annotate({ action: { name: "settings.telegram.test" }, meta: { success: true } });

  return apiSuccess({ sent: true });
});
