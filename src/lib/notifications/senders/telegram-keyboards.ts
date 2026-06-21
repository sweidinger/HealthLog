/**
 * v1.19.0 — inline keyboards for the interactive mood + measurement
 * reminders. Mirrors the medication keyboard pattern: callback_data values
 * are STABLE, locale-independent identifiers (decoupled from the button
 * label, which is localised). The webhook parses these ids; never the label.
 *
 * Tone is restrained and clinical — plain "1 2 3 4 5", no emoji, no
 * gamification (no streaks/points). The mood scale matches the app's
 * canonical 1..5 (`MOOD_SCORE_BY_ENUM`).
 */
import { getServerTranslator } from "@/lib/i18n/server-translator";
import type { Locale } from "@/lib/i18n/config";

export interface TelegramInlineKeyboard {
  inline_keyboard: { text: string; callback_data: string }[][];
}

/**
 * Mood reminder keyboard: a 1–5 row, then a "Note…" / "Later" row.
 *
 *   mood:<score>      → log a MoodEntry with that score
 *   mood_note         → open a force_reply prompt to attach a note
 *   mood_later:<min>  → re-enqueue the nudge after <min> minutes
 */
export function buildMoodKeyboard(locale: Locale): TelegramInlineKeyboard {
  const { t } = getServerTranslator(locale);
  return {
    inline_keyboard: [
      [1, 2, 3, 4, 5].map((score) => ({
        text: String(score),
        callback_data: `mood:${score}`,
      })),
      [
        {
          text: t("telegram.buttonMoodNote"),
          callback_data: "mood_note",
        },
        {
          text: t("telegram.buttonLater"),
          callback_data: "mood_later:120",
        },
      ],
    ],
  };
}

/**
 * Measurement (Vorsorge) reminder keyboard: "Done" / "Later". No value
 * capture — completion + snooze only, to keep it restrained.
 *
 *   measure_done:<reminderId>      → satisfy the reminder
 *   measure_later:<reminderId>:<min> → re-enqueue after <min> minutes
 */
export function buildMeasurementKeyboard(
  reminderId: string,
  locale: Locale,
): TelegramInlineKeyboard {
  const { t } = getServerTranslator(locale);
  return {
    inline_keyboard: [
      [
        {
          text: t("telegram.buttonDone"),
          callback_data: `measure_done:${reminderId}`,
        },
        {
          text: t("telegram.buttonLater"),
          callback_data: `measure_later:${reminderId}:180`,
        },
      ],
    ],
  };
}
