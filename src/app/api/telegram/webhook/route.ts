import { timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import {
  answerTelegramCallbackQuery,
  deleteMessage,
  sendTelegramMessage,
} from "@/lib/telegram";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/api-response";
import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { annotate, getEvent } from "@/lib/logging/context";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { locales, type Locale } from "@/lib/i18n/config";
import { recomputeMedicationComplianceForEvent } from "@/lib/rollups/medication-compliance-rollups";
import {
  applyCanonicalSlotWrite,
  resolveForcedSlotForWrite,
  resolveSlotForWriteByBand,
} from "@/lib/medications/scheduling/slot-upsert";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import {
  consumeForIntake,
  restoreForIntake,
} from "@/lib/medications/inventory/consumption";
import { localHmAsUtc } from "@/lib/tz/local-day";
import { wallClockInTz } from "@/lib/tz/wall-clock";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id?: number;
    text?: string;
    chat?: { id: number | string };
  };
  callback_query?: {
    id: string;
    data?: string;
    from?: { id?: number | string };
    message?: {
      message_id?: number;
      chat?: { id: number | string };
    };
  };
}

function hasValidSecret(request: NextRequest): boolean {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) {
    getEvent()?.addWarning("TELEGRAM_WEBHOOK_SECRET not configured");
    return false;
  }
  const received = request.headers.get("x-telegram-bot-api-secret-token");
  if (!received) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function toChatId(value: number | string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  return String(value);
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Resolve the bot locale for an existing Telegram user.
 *
 * Defaults to "de" when User.locale is null — existing bots were set up in
 * German and we don't want to silently flip them. Users who have switched
 * the UI to English (User.locale = "en") get an English bot too.
 */
function resolveBotLocale(value: string | null | undefined): Locale {
  if (value && (locales as readonly string[]).includes(value)) {
    return value as Locale;
  }
  return "de";
}

async function cleanupReminderTracking(medicationId: string): Promise<void> {
  try {
    await prisma.telegramReminderMessage.deleteMany({
      where: { medicationId },
    });
  } catch {
    // Best-effort cleanup
  }
}

const AUTO_DELETE_DELAY_MS = 60 * 60 * 1000; // 1 hour

async function scheduleAutoDelete(
  userId: string,
  chatId: string,
  messageIds: number[],
): Promise<void> {
  const deleteAfter = new Date(Date.now() + AUTO_DELETE_DELAY_MS);
  try {
    await prisma.telegramScheduledDeletion.createMany({
      data: messageIds.map((messageId) => ({
        userId,
        chatId,
        messageId,
        deleteAfter,
      })),
    });
  } catch {
    // Best-effort
  }
}

async function findTelegramUser(chatId: string) {
  return prisma.user.findFirst({
    where: {
      telegramEnabled: true,
      telegramChatId: chatId,
      telegramBotToken: { not: null },
    },
    select: {
      id: true,
      telegramBotToken: true,
      locale: true,
      // v1.4.39 W-MED — pulled into the select so the post-write
      // compliance-rollup hook can anchor the user-day bucket.
      timezone: true,
    },
  });
}

/**
 * v1.16.9 — the slot a Telegram action should converge onto.
 *
 * The reminder context knows its own slot: the dispatcher records every
 * reminder message as a `TelegramReminderMessage` row carrying the
 * local `date` + `timeOfDay` of the dose it fired for. When the action
 * callback carries the chat/message ids, that row names the EXACT slot
 * — preferred over band attribution, which would orphan a confirmation
 * tapped hours after the reminder (band closed → ad-hoc) even though
 * the user is answering a specific dose prompt.
 *
 * Returns the canonical band anchor (validated against the schedule's
 * real slots), or `null` when no reminder row matches / the instant is
 * not a real slot — the caller then falls back to band attribution.
 */
async function resolveReminderSlot(input: {
  userId: string;
  medicationId: string;
  userTz: string;
  chatId: string;
  messageId: number;
}): Promise<Date | null> {
  const reminder = await prisma.telegramReminderMessage.findFirst({
    where: {
      medicationId: input.medicationId,
      chatId: input.chatId,
      messageId: input.messageId,
    },
    select: { date: true, timeOfDay: true },
  });
  if (!reminder) return null;
  const instant = reminderLocalInstant(
    reminder.date,
    reminder.timeOfDay,
    input.userTz,
  );
  if (!instant) return null;
  // Validate against the medication's real band anchors so a stale or
  // malformed reminder row can never park a dose on a non-slot instant.
  return resolveForcedSlotForWrite({
    userId: input.userId,
    medicationId: input.medicationId,
    userTz: input.userTz,
    slotInstant: instant,
  });
}

/**
 * Mint the UTC instant of local `timeOfDay` on the local calendar day
 * `date` (YYYY-MM-DD) in `tz`. Probes a reference instant a day either
 * side of UTC noon so the result is correct in every zone offset, then
 * derives the DST-correct instant via `localHmAsUtc`.
 */
function reminderLocalInstant(
  date: string,
  timeOfDay: string,
  tz: string,
): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(timeOfDay)) {
    return null;
  }
  const [hour, minute] = timeOfDay.split(":").map(Number);
  const base = new Date(`${date}T12:00:00.000Z`);
  if (Number.isNaN(base.getTime())) return null;
  for (const shiftDays of [0, -1, 1]) {
    const ref = new Date(base.getTime() + shiftDays * 24 * 60 * 60 * 1000);
    const parts = wallClockInTz(ref, tz);
    const localDay = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(
      parts.day,
    ).padStart(2, "0")}`;
    if (localDay === date) return localHmAsUtc(ref, tz, hour, minute);
  }
  return null;
}

async function markMedicationTaken(
  userId: string,
  medicationId: string,
  idempotencyKey: string,
  locale: Locale,
  userTz: string | null,
  reminderRef?: { chatId: string; messageId: number },
): Promise<{ ok: boolean; message: string; medicationName?: string }> {
  const { t } = getServerTranslator(locale);
  const medication = await prisma.medication.findFirst({
    where: { id: medicationId, userId, active: true },
    select: { id: true, name: true },
  });
  if (!medication) {
    return { ok: false, message: t("telegram.errorMedicationInactive") };
  }

  const existing = await prisma.medicationIntakeEvent.findFirst({
    where: { userId, medicationId: medication.id, idempotencyKey },
    select: { id: true },
  });

  let scheduledFor: Date | null = null;
  if (!existing) {
    const takenAt = new Date();
    const tz = userTz || DEFAULT_TIMEZONE;

    // v1.16.9 — converge onto the slot's canonical row instead of bare-
    // creating a second row anchored at `now`. The old shape left the
    // worker-minted pending REMINDER row open: the slot later auto-missed
    // and compliance punished a dose the user explicitly confirmed.
    // Prefer the reminder's own slot (the message names the dose it fired
    // for); fall back to band attribution on the tap instant.
    let canonicalSlot: Date | null = reminderRef
      ? await resolveReminderSlot({
          userId,
          medicationId: medication.id,
          userTz: tz,
          chatId: reminderRef.chatId,
          messageId: reminderRef.messageId,
        })
      : null;
    if (canonicalSlot === null) {
      const attribution = await resolveSlotForWriteByBand({
        userId,
        medicationId: medication.id,
        userTz: tz,
        takenAt,
      });
      canonicalSlot = attribution.slotInstant;
    }

    // The intake write and the snooze reset commit atomically — a
    // recorded dose must never leave the medication snoozed-out of its
    // own reminders, and a snooze reset must never land without the dose
    // (the pre-band shape used a batch transaction here; the slot
    // convergence dropped it). The canonical slot write accepts the
    // transaction client; its P2002 race-recovery cannot continue inside
    // an aborted Postgres transaction, so the rare create race rolls the
    // whole write back instead of converging in place — Telegram
    // redelivers the non-200 update and the retry finds the raced row.
    const written = await prisma.$transaction(async (tx) => {
      let slotScheduledFor: Date;
      let eventId: string;
      // v1.16.10 — only a genuine pending→taken transition may consume
      // inventory units; a redelivered button press converging onto an
      // already-taken slot row (including a pre-stamp row) must not.
      let consumedTransition = true;
      if (canonicalSlot) {
        const applied = await applyCanonicalSlotWrite({
          client: tx,
          userId,
          medicationId: medication.id,
          canonicalSlot,
          takenAt,
          skipped: false,
          isExplicitTaken: true,
          isExplicitSkip: false,
          idempotencyKey,
          createSource: "REMINDER",
          attributionSource: "AUTO",
        });
        slotScheduledFor = applied.row.scheduledFor;
        eventId = applied.row.id;
        consumedTransition = applied.consumedTransition;
      } else {
        // Ad-hoc / PRN — standalone row under the documented contract
        // (`scheduledFor = takenAt`).
        const created = await tx.medicationIntakeEvent.create({
          data: {
            userId,
            medicationId: medication.id,
            scheduledFor: takenAt,
            takenAt,
            skipped: false,
            source: "REMINDER",
            idempotencyKey,
          },
        });
        slotScheduledFor = created.scheduledFor;
        eventId = created.id;
      }
      await tx.medication.update({
        where: { id: medication.id },
        data: { snoozedUntil: null },
      });
      return { slotScheduledFor, eventId, consumedTransition };
    });
    scheduledFor = written.slotScheduledFor;
    // v1.16.10 — the button confirmed a take; consume inventory units.
    // Runs after the intake transaction committed (the dose record must
    // never hinge on the stock write); the stamp keeps a Telegram
    // redelivery exactly-once and the transition gate keeps a re-press
    // on an already-taken slot from decrementing through a pre-stamp
    // row.
    if (written.consumedTransition) {
      await consumeForIntake({
        client: prisma,
        userId,
        medicationId: medication.id,
        eventId: written.eventId,
        intakeAt: takenAt,
      });
    }
    // The confirmation must reflect on the next read (today feed, card
    // pill, compliance) rather than wait out the cache TTL.
    invalidateUserMedications(userId, { evict: true });
  }

  // v1.4.39 W-MED — refresh the compliance rollup for the
  // affected day so the next read after the cache miss reflects the
  // new dose. Only fires when the write landed a row.
  if (scheduledFor) {
    await recomputeMedicationComplianceForEvent({
      userId,
      medicationId: medication.id,
      scheduledFor,
      tz: userTz,
    });
  }

  return {
    ok: true,
    message: existing
      ? t("telegram.alreadyRecorded", { name: medication.name })
      : t("telegram.recordedAsTaken", { name: medication.name }),
    medicationName: medication.name,
  };
}

async function handleCallback(update: TelegramUpdate) {
  const callback = update.callback_query;
  if (!callback) return;

  const chatId =
    toChatId(callback.message?.chat?.id) ?? toChatId(callback.from?.id);
  if (!chatId) return;

  const user = await findTelegramUser(chatId);
  if (!user?.telegramBotToken) return;
  const botToken = decrypt(user.telegramBotToken);
  const locale = resolveBotLocale(user.locale);
  const { t } = getServerTranslator(locale);

  const data = callback.data ?? "";
  const messageId = callback.message?.message_id;

  if (data.startsWith("taken:")) {
    const medicationId = data.slice("taken:".length).trim();
    if (!medicationId) {
      await answerTelegramCallbackQuery(
        botToken,
        callback.id,
        t("telegram.errorInvalidAction"),
      );
      return;
    }

    const msgId = messageId ?? "na";
    const idempotencyKey =
      `telegram:cb:${chatId}:${msgId}:${medicationId}`.slice(0, 128);

    const result = await markMedicationTaken(
      user.id,
      medicationId,
      idempotencyKey,
      locale,
      user.timezone,
      messageId !== undefined ? { chatId, messageId } : undefined,
    );
    await answerTelegramCallbackQuery(botToken, callback.id, result.message);
    if (messageId) {
      await deleteMessage(botToken, chatId, messageId);
    }
    await cleanupReminderTracking(medicationId);
  } else if (data.startsWith("snooze:")) {
    // Format: "snooze:{medicationId}:{minutes}"
    const parts = data.split(":");
    const medicationId = parts[1];
    const minutes = parseInt(parts[2], 10);
    if (!medicationId || !Number.isFinite(minutes)) {
      await answerTelegramCallbackQuery(
        botToken,
        callback.id,
        t("telegram.errorInvalidAction"),
      );
      return;
    }

    const medication = await prisma.medication.findFirst({
      where: { id: medicationId, userId: user.id, active: true },
      select: { id: true, name: true },
    });
    if (!medication) {
      await answerTelegramCallbackQuery(
        botToken,
        callback.id,
        t("telegram.errorMedicationNotFound"),
      );
      return;
    }

    await prisma.medication.update({
      where: { id: medication.id },
      data: { snoozedUntil: new Date(Date.now() + minutes * 60000) },
    });

    const duration =
      minutes <= 60
        ? t("telegram.snoozeOneHour")
        : t("telegram.snoozeThreeHours");
    await answerTelegramCallbackQuery(
      botToken,
      callback.id,
      t("telegram.snoozedFor", { name: medication.name, duration }),
    );
    if (messageId) {
      await deleteMessage(botToken, chatId, messageId);
    }
    await cleanupReminderTracking(medicationId);
  } else if (data.startsWith("skip:")) {
    const medicationId = data.slice("skip:".length).trim();
    if (!medicationId) {
      await answerTelegramCallbackQuery(
        botToken,
        callback.id,
        t("telegram.errorInvalidAction"),
      );
      return;
    }

    const medication = await prisma.medication.findFirst({
      where: { id: medicationId, userId: user.id, active: true },
      select: { id: true, name: true },
    });
    if (!medication) {
      await answerTelegramCallbackQuery(
        botToken,
        callback.id,
        t("telegram.errorMedicationNotFound"),
      );
      return;
    }

    const msgId = messageId ?? "na";
    const idempotencyKey =
      `telegram:skip:${chatId}:${msgId}:${medicationId}`.slice(0, 128);

    const existing = await prisma.medicationIntakeEvent.findFirst({
      where: { userId: user.id, medicationId: medication.id, idempotencyKey },
      select: { id: true },
    });

    let skippedScheduledFor: Date | null = null;
    if (!existing) {
      const endOfDay = new Date();
      endOfDay.setHours(23, 59, 59, 999);
      const skipMoment = new Date();
      const tz = user.timezone || DEFAULT_TIMEZONE;

      // v1.16.9 — a Telegram skip answers a specific dose prompt, so it
      // must converge onto the slot's pending row like a take does. The
      // old shape inserted a second row anchored at `now` and left the
      // pending REMINDER row open to auto-miss — the user's deliberate
      // skip recorded as a miss AND an orphan. Prefer the reminder's own
      // slot; fall back to the band the skip moment falls in.
      let canonicalSlot: Date | null =
        messageId !== undefined
          ? await resolveReminderSlot({
              userId: user.id,
              medicationId: medication.id,
              userTz: tz,
              chatId,
              messageId,
            })
          : null;
      if (canonicalSlot === null) {
        const attribution = await resolveSlotForWriteByBand({
          userId: user.id,
          medicationId: medication.id,
          userTz: tz,
          takenAt: skipMoment,
        });
        canonicalSlot = attribution.slotInstant;
      }

      // Atomic like the take path: the skip row and the rest-of-day
      // snooze commit together, so a failure can never leave the user
      // re-reminded for a recorded skip or silenced without one. Same
      // P2002 trade-off as the take path — the rare create race rolls
      // back and Telegram's redelivery converges on the raced row.
      const writtenSkip = await prisma.$transaction(async (tx) => {
        let slotScheduledFor: Date;
        let eventId: string;
        if (canonicalSlot) {
          const applied = await applyCanonicalSlotWrite({
            client: tx,
            userId: user.id,
            medicationId: medication.id,
            canonicalSlot,
            takenAt: null,
            skipped: true,
            isExplicitTaken: false,
            isExplicitSkip: true,
            idempotencyKey,
            createSource: "REMINDER",
          });
          slotScheduledFor = applied.row.scheduledFor;
          eventId = applied.row.id;
        } else {
          const created = await tx.medicationIntakeEvent.create({
            data: {
              userId: user.id,
              medicationId: medication.id,
              scheduledFor: skipMoment,
              takenAt: null,
              skipped: true,
              source: "REMINDER",
              idempotencyKey,
            },
          });
          slotScheduledFor = created.scheduledFor;
          eventId = created.id;
        }
        await tx.medication.update({
          where: { id: medication.id },
          data: { snoozedUntil: endOfDay },
        });
        return { slotScheduledFor, eventId };
      });
      skippedScheduledFor = writtenSkip.slotScheduledFor;
      // v1.16.10 — an explicit skip can downgrade a previously-taken
      // slot row (last-write-wins); refund whatever its consumption
      // stamp recorded. No-op for a never-consumed row.
      await restoreForIntake({
        client: prisma,
        userId: user.id,
        eventId: writtenSkip.eventId,
      });
      invalidateUserMedications(user.id, { evict: true });
    }

    // v1.4.39 W-MED — refresh the compliance rollup for the skipped
    // event's user-day so the next read sees the (scheduled, skipped)
    // counts incremented.
    if (skippedScheduledFor) {
      await recomputeMedicationComplianceForEvent({
        userId: user.id,
        medicationId: medication.id,
        scheduledFor: skippedScheduledFor,
        tz: user.timezone,
      });
    }

    await answerTelegramCallbackQuery(
      botToken,
      callback.id,
      t("telegram.skipped", { name: medication.name }),
    );
    if (messageId) {
      await deleteMessage(botToken, chatId, messageId);
    }
    await cleanupReminderTracking(medicationId);
  } else if (data.startsWith("ack:")) {
    const medicationId = data.slice("ack:".length).trim();
    if (!medicationId) {
      await answerTelegramCallbackQuery(
        botToken,
        callback.id,
        t("telegram.errorInvalidAction"),
      );
      return;
    }

    const medication = await prisma.medication.findFirst({
      where: { id: medicationId, userId: user.id },
      select: { id: true, name: true },
    });

    await answerTelegramCallbackQuery(
      botToken,
      callback.id,
      medication
        ? t("telegram.confirmed", { name: medication.name })
        : t("telegram.genericConfirmed"),
    );
    if (messageId) {
      await deleteMessage(botToken, chatId, messageId);
    }
    await cleanupReminderTracking(medicationId);
  } else if (data.startsWith("add:")) {
    // Format: "add:{medicationId}" or "add:{medicationId}:umid:{userMsgId}"
    const withoutPrefix = data.slice("add:".length);
    const umidIdx = withoutPrefix.indexOf(":umid:");
    const medicationId =
      umidIdx >= 0 ? withoutPrefix.slice(0, umidIdx) : withoutPrefix.trim();
    if (!medicationId) {
      await answerTelegramCallbackQuery(
        botToken,
        callback.id,
        t("telegram.errorInvalidAction"),
      );
      return;
    }

    const msgId = messageId ?? "na";
    const idempotencyKey =
      `telegram:add:${chatId}:${msgId}:${medicationId}`.slice(0, 128);

    const result = await markMedicationTaken(
      user.id,
      medicationId,
      idempotencyKey,
      locale,
      user.timezone,
    );
    await answerTelegramCallbackQuery(botToken, callback.id, result.message);
    if (messageId) {
      await deleteMessage(botToken, chatId, messageId);
    }
    // Also delete the user's /add command message if encoded
    const userMsgMatch = data.match(/:umid:(\d+)$/);
    if (userMsgMatch) {
      const userMsgId = parseInt(userMsgMatch[1], 10);
      if (Number.isFinite(userMsgId)) {
        await deleteMessage(botToken, chatId, userMsgId).catch(() => {});
      }
    }
  } else if (data.startsWith("cancel_add")) {
    // Delete the bot's selection message
    if (messageId) {
      await deleteMessage(botToken, chatId, messageId);
    }
    // Delete the user's original /add command message if encoded
    const userMsgMatch = data.match(/:umid:(\d+)$/);
    if (userMsgMatch) {
      const userMsgId = parseInt(userMsgMatch[1], 10);
      if (Number.isFinite(userMsgId)) {
        await deleteMessage(botToken, chatId, userMsgId).catch(() => {});
      }
    }
    await answerTelegramCallbackQuery(
      botToken,
      callback.id,
      t("telegram.cancelled"),
    );
  } else {
    await answerTelegramCallbackQuery(
      botToken,
      callback.id,
      t("telegram.errorUnknownAction"),
    );
  }
}

async function handleTextMessage(update: TelegramUpdate) {
  const message = update.message;
  const text = message?.text?.trim();
  const chatId = toChatId(message?.chat?.id);
  if (!text || !chatId) return;

  const user = await findTelegramUser(chatId);
  if (!user?.telegramBotToken) return;
  const botToken = decrypt(user.telegramBotToken);
  const locale = resolveBotLocale(user.locale);
  const { t } = getServerTranslator(locale);

  // "Help" / start: accept English + German keyword aliases independent of locale
  if (
    /^\/help\b/i.test(text) ||
    /^\/start\b/i.test(text) ||
    /^hilfe$/i.test(text) ||
    /^help$/i.test(text)
  ) {
    const userMsgId = message?.message_id;
    const resp = await sendTelegramMessage(
      botToken,
      chatId,
      `${t("telegram.helpHeader")}\n\n${t("telegram.helpBody")}`,
    );
    const toDelete = [userMsgId, resp.messageId].filter(
      (id): id is number => id != null,
    );
    if (toDelete.length > 0) {
      await scheduleAutoDelete(user.id, chatId, toDelete);
    }
    return;
  }

  if (/^\/add\b/i.test(text)) {
    const userMsgId = message?.message_id;
    const meds = await prisma.medication.findMany({
      where: { userId: user.id, active: true },
      select: { id: true, name: true, dose: true },
      orderBy: { name: "asc" },
    });

    if (meds.length === 0) {
      const resp = await sendTelegramMessage(
        botToken,
        chatId,
        t("telegram.noActiveMedications"),
      );
      const toDelete = [userMsgId, resp.messageId].filter(
        (id): id is number => id != null,
      );
      if (toDelete.length > 0) {
        await scheduleAutoDelete(user.id, chatId, toDelete);
      }
      return;
    }

    if (meds.length === 1) {
      const idempotencyKey =
        `telegram:add:${update.update_id}:${meds[0].id}`.slice(0, 128);
      const result = await markMedicationTaken(
        user.id,
        meds[0].id,
        idempotencyKey,
        locale,
        user.timezone,
      );
      const resp = await sendTelegramMessage(
        botToken,
        chatId,
        result.ok
          ? `${escapeHtml(result.message)}`
          : `${escapeHtml(result.message)}`,
      );
      const toDelete = [userMsgId, resp.messageId].filter(
        (id): id is number => id != null,
      );
      if (toDelete.length > 0) {
        await scheduleAutoDelete(user.id, chatId, toDelete);
      }
      return;
    }

    // Encode user's message ID in callback data so cancel/add can delete it
    const umidSuffix = userMsgId ? `:umid:${userMsgId}` : "";
    const keyboard = {
      inline_keyboard: [
        ...meds.map((med) => [
          {
            text: `${med.name} (${med.dose})`,
            callback_data: `add:${med.id}${umidSuffix}`,
          },
        ]),
        [
          {
            text: t("telegram.cancelButton"),
            callback_data: `cancel_add${umidSuffix}`,
          },
        ],
      ],
    };
    const resp = await sendTelegramMessage(
      botToken,
      chatId,
      t("telegram.whichMedication"),
      { parseMode: "HTML", replyMarkup: keyboard },
    );
    // Fallback auto-delete if user never interacts with the selection
    const toDelete = [userMsgId, resp.messageId].filter(
      (id): id is number => id != null,
    );
    if (toDelete.length > 0) {
      await scheduleAutoDelete(user.id, chatId, toDelete);
    }
    return;
  }

  // Greeting responses (kept locale-independent)
  const greetings = ["hi", "hallo", "hey", "moin", "hello"];
  const lowerText = text.toLowerCase();
  const matchedGreeting = greetings.find((g) => lowerText === g);
  if (matchedGreeting) {
    const userMsgId = message?.message_id;
    const reply = text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
    const resp = await sendTelegramMessage(botToken, chatId, `${reply}! 👋`);
    const toDelete = [userMsgId, resp.messageId].filter(
      (id): id is number => id != null,
    );
    if (toDelete.length > 0) {
      await scheduleAutoDelete(user.id, chatId, toDelete);
    }
    return;
  }

  // Accept both "genommen <name>" (DE) and "taken <name>" (EN) regardless of
  // the user's UI locale — keeps backwards compatibility.
  const intakeKeyword = /^(?:genommen|taken)\b/i;
  if (!intakeKeyword.test(text)) return;

  const userMsgId = message?.message_id;
  const nameInput = text.replace(intakeKeyword, "").trim();

  let medicationId: string | null = null;
  if (nameInput) {
    const med = await prisma.medication.findFirst({
      where: {
        userId: user.id,
        active: true,
        name: { equals: nameInput, mode: "insensitive" },
      },
      select: { id: true },
    });
    medicationId = med?.id ?? null;
  } else {
    const meds = await prisma.medication.findMany({
      where: { userId: user.id, active: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
      take: 2,
    });
    if (meds.length === 1) {
      medicationId = meds[0].id;
    } else {
      const resp = await sendTelegramMessage(
        botToken,
        chatId,
        t("telegram.askMedicationName"),
      );
      const toDelete = [userMsgId, resp.messageId].filter(
        (id): id is number => id != null,
      );
      if (toDelete.length > 0) {
        await scheduleAutoDelete(user.id, chatId, toDelete);
      }
      return;
    }
  }

  if (!medicationId) {
    const resp = await sendTelegramMessage(
      botToken,
      chatId,
      t("telegram.medicationNotFoundExact"),
    );
    const toDelete = [userMsgId, resp.messageId].filter(
      (id): id is number => id != null,
    );
    if (toDelete.length > 0) {
      await scheduleAutoDelete(user.id, chatId, toDelete);
    }
    return;
  }

  const idempotencyKey =
    `telegram:text:${update.update_id}:${medicationId}`.slice(0, 128);
  const result = await markMedicationTaken(
    user.id,
    medicationId,
    idempotencyKey,
    locale,
    user.timezone,
  );
  const resp = await sendTelegramMessage(
    botToken,
    chatId,
    result.ok
      ? `✅ ${escapeHtml(result.message)}`
      : `⚠️ ${escapeHtml(result.message)}`,
  );
  const toDelete = [userMsgId, resp.messageId].filter(
    (id): id is number => id != null,
  );
  if (toDelete.length > 0) {
    await scheduleAutoDelete(user.id, chatId, toDelete);
  }
}

export const POST = apiHandler(async (request: NextRequest) => {
  annotate({ action: { name: "telegram.webhook" } });

  const ip = getClientIp(request);
  const rl = await checkRateLimit(`telegram-webhook:${ip}`, 120, 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { status: "rate_limited" },
      { status: 429, headers: rateLimitHeaders(rl) },
    );
  }

  if (!hasValidSecret(request)) {
    return NextResponse.json({ status: "unauthorized" }, { status: 401 });
  }

  getEvent()?.setAuth({ auth_method: "telegram_webhook" });

  let update: TelegramUpdate;
  try {
    const raw = await request.text();
    if (raw.length > 256 * 1024) {
      // Oversized payload — acknowledge with 200 like invalid JSON so the
      // sender does not retry-loop the update.
      return NextResponse.json({ status: "invalid json" }, { status: 200 });
    }
    update = JSON.parse(raw) as TelegramUpdate;
  } catch {
    return NextResponse.json({ status: "invalid json" }, { status: 200 });
  }
  if (!update || typeof update.update_id !== "number") {
    return NextResponse.json({ status: "ignored" }, { status: 200 });
  }

  annotate({ meta: { update_id: update.update_id } });

  if (update.callback_query) {
    await handleCallback(update);
    return NextResponse.json({ status: "ok" }, { status: 200 });
  }

  if (update.message?.text) {
    await handleTextMessage(update);
    return NextResponse.json({ status: "ok" }, { status: 200 });
  }

  return NextResponse.json({ status: "ignored" }, { status: 200 });
});

export const GET = apiHandler(async (request: NextRequest) => {
  annotate({ action: { name: "telegram.webhook.verify" } });

  if (!hasValidSecret(request)) {
    return NextResponse.json({ status: "unauthorized" }, { status: 401 });
  }
  getEvent()?.setAuth({ auth_method: "telegram_webhook" });
  return NextResponse.json({ status: "ok" }, { status: 200 });
});
