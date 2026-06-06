/**
 * Strip decorative emoji from push notification content.
 *
 * Operator + iOS contract (2026-06): routine reminder pushes
 * (medication-due, mood-nudge, daily-briefing, cycle reminders) must be
 * plain text — no emoji, no decorative bubbles. iOS renders the APNs
 * `title`/`body` verbatim, so the colour-coded phase markers (🟢🟡🟠🔴) the
 * reminder strings carry for the Telegram channel leak onto the lock
 * screen. Emoji stay acceptable only for system / failure alerts
 * (`SYSTEM_ALERT`), where they flag severity.
 *
 * The push senders (APNs, Web Push, ntfy) run reminder content through
 * this; Telegram keeps the emoji (idiomatic there, and its inline keyboard
 * relies on glyph-labelled action buttons). `shouldStripEmoji` keeps the
 * SYSTEM_ALERT carve-out in one place.
 *
 * The range set targets the actual emoji blocks (supplementary
 * pictographs, misc symbols, dingbats, geometric/arrow emoji, regional
 * indicators, variation selectors, keycap) and deliberately spares the
 * BMP punctuation that doubles as text — ™ © ® and the like — so a brand
 * name in a medication title is not mangled.
 */
const EMOJI_RE =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{20E3}\u{231A}\u{231B}\u{23E9}-\u{23FA}]/gu;

/** Remove decorative emoji and collapse the whitespace they leave behind. */
export function stripDecorativeEmoji(text: string): string {
  return text.replace(EMOJI_RE, "").replace(/\s+/g, " ").trim();
}

/**
 * Whether a push channel should strip emoji for this event. Everything
 * except `SYSTEM_ALERT` is a routine notification and goes plain. Accepts a
 * bare string so it composes with senders that carry `eventType` widened to
 * `string` on the wire payload.
 */
export function shouldStripEmoji(eventType: string): boolean {
  return eventType !== "SYSTEM_ALERT";
}

/**
 * Apply the reminder plain-text rule to a single push field: strip emoji
 * unless the event is a system / failure alert.
 */
export function plainPushText(text: string, eventType: string): string {
  return shouldStripEmoji(eventType) ? stripDecorativeEmoji(text) : text;
}
