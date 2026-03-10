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
    return apiError("Maximal 5 Tests in 5 Minuten", 429);
  }

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: { telegramBotToken: true, telegramChatId: true },
  });

  if (!dbUser?.telegramBotToken || !dbUser?.telegramChatId) {
    return apiError(
      "Bot-Token und Chat-ID muessen zuerst gespeichert werden",
      422,
    );
  }

  const botToken = decrypt(dbUser.telegramBotToken);
  const ok = await sendTelegramMessage(
    botToken,
    dbUser.telegramChatId,
    "HealthLog: Verbindung erfolgreich! Telegram-Benachrichtigungen sind aktiv.",
  );

  if (!ok) {
    return apiError(
      "Nachricht konnte nicht gesendet werden. Pruefe Bot-Token und Chat-ID.",
      422,
    );
  }

  annotate({ action: { name: "settings.telegram.test" }, meta: { success: true } });

  return apiSuccess({ sent: true });
});
