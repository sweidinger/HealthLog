import { getNumberFormat, getDateTimeFormat } from "@/lib/intl/formatter-cache";
import {
  hourCycleOptions,
  type TimeFormatPreference,
} from "@/lib/format-locale";

/**
 * Shared formatters for the workout-detail surface. Pure helpers pulled
 * out of the former single `workout-detail.tsx` when it was split into a
 * `workout-detail/` directory (#67), so header / stats / splits format
 * durations and distances identically.
 */

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}h ${m.toString().padStart(2, "0")}m ${s.toString().padStart(2, "0")}s`;
  }
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

/** Compact "34 min" style duration for the sport-average comparison line. */
export function formatDurationMinutes(seconds: number, locale: string): string {
  const minutes = Math.round(seconds / 60);
  return formatNumber(minutes, locale);
}

export function formatDistanceKm(meters: number, locale: string): string {
  const km = meters / 1000;
  return getNumberFormat(locale, {
    maximumFractionDigits: 2,
    minimumFractionDigits: km < 10 ? 2 : 1,
  }).format(km);
}

export function formatNumber(
  value: number,
  locale: string,
  fractionDigits = 0,
): string {
  return getNumberFormat(locale, {
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: fractionDigits,
  }).format(value);
}

export function formatPaceMinPerKm(
  durationSec: number,
  meters: number,
): string {
  // Seconds-per-kilometre. Only meaningful for run / walk / hike / ride;
  // the caller gates on distance + sport.
  const secPerKm = (durationSec / meters) * 1000;
  return formatPaceSeconds(secPerKm);
}

/** "m:ss /km" from a seconds-per-km value (used by pace + splits). */
export function formatPaceSeconds(secPerKm: number): string {
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${s.toString().padStart(2, "0")} /km`;
}

export function formatDateRange(
  startedAt: string,
  endedAt: string,
  locale: string,
  timeFormat: TimeFormatPreference,
): string {
  const start = new Date(startedAt);
  const end = new Date(endedAt);
  const dateFmt = getDateTimeFormat(locale, {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
  const timeFmt = getDateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    ...hourCycleOptions(timeFormat),
  });
  return `${dateFmt.format(start)} · ${timeFmt.format(start)} – ${timeFmt.format(end)}`;
}
