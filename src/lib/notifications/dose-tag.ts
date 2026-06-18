/**
 * v1.18.4 — stable Web Push notification tag for a medication dose slot.
 *
 * A PWA self-hoster with no Apple Developer account has no Live Activity to
 * end when a dose is logged. Instead the server pushes a `type: "clear"`
 * web-push that the service worker turns into `getNotifications({ tag })` +
 * `notification.close()`. For that to work the REMINDER push and the CLEAR
 * push must agree on a single, stable tag per dose slot.
 *
 * The slot is uniquely identified by `(medicationId, scheduledFor-instant)`:
 *  - the dose-due reminder fires with `scheduledAt` = the slot's ISO instant,
 *  - the clear-on-taken fires with `scheduledFor` = the same ISO instant.
 *
 * `scheduledFor` is normalised through `Date` so a reminder ISO carrying
 * milliseconds and a clear ISO without them still collapse to one tag.
 */
export function medicationDoseTag(
  medicationId: string,
  scheduledForIso: string,
): string {
  const t = Date.parse(scheduledForIso);
  const instant = Number.isNaN(t) ? scheduledForIso : new Date(t).toISOString();
  return `med:${medicationId}:${instant}`;
}
