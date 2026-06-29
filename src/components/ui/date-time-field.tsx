"use client";

import * as React from "react";
import { Calendar } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  useTranslations,
  useDateFormatPreference,
  useTimeFormatPreference,
} from "@/lib/i18n/context";
import { formatDate, resolveDateLocale } from "@/lib/date-format";
import { hourCycleOptions } from "@/lib/format-locale";

/**
 * Dependency-free datetime input that DISPLAYS the value in the user's
 * date-order preference (date part) and hour-cycle preference (time part)
 * while editing rides the browser's native datetime picker.
 *
 * The committed VALUE is always a local `yyyy-MM-ddTHH:mm` string — identical
 * to the native `<input type="datetime-local">` contract `<DateTimeInput>`
 * ships — so this is a drop-in for `<DateTimeInput>`. The value is a wall-clock
 * local instant (no zone), so display parsing reads the literal parts rather
 * than re-interpreting them through a timezone.
 *
 * How it works mirrors `<DateField>`:
 *   - A visually-hidden native `<input type="datetime-local">` holds the real
 *     value and emits the change events the form listens to. Tapping the field
 *     (or its calendar button) calls `showPicker()`, falling back to `focus()`.
 *   - A read-only text overlay paints the formatted display string (date in
 *     the date-order preference, time in the hour-cycle preference) or the
 *     placeholder. Free-typed entry is not offered — the datetime parts are
 *     ambiguous enough that the native picker is the only edit path, same as
 *     the original `<DateTimeInput>` (which exposed no text fallback either).
 *
 * Height / a11y / target-size parity with `<DateTimeInput>`: the same
 * `min-h-11 h-11 sm:min-h-10 sm:h-10` floor (WCAG 2.5.5) and focus vocabulary.
 */

// Mirrors the `<DateInput>` / `<DateTimeInput>` height contract.
const FIELD_HEIGHT_CLASSES = "min-h-11 h-11 sm:min-h-10 sm:h-10";

const FIELD_BASE_CLASSES =
  "border-input bg-background text-foreground ring-offset-background placeholder:text-muted-foreground focus-within:ring-ring relative flex w-full items-center rounded-md border ps-3 pe-2 text-sm shadow-xs transition-[color,box-shadow] focus-within:ring-2 focus-within:ring-offset-2 focus-within:outline-none";

export interface DateTimeFieldProps {
  id?: string;
  name?: string;
  /** Local `yyyy-MM-ddTHH:mm` (controlled). */
  value?: string;
  /** Initial local `yyyy-MM-ddTHH:mm` (uncontrolled). */
  defaultValue?: string;
  onChange?: (value: string) => void;
  onBlur?: () => void;
  disabled?: boolean;
  required?: boolean;
  /** Local `yyyy-MM-ddTHH:mm`. */
  min?: string;
  /** Local `yyyy-MM-ddTHH:mm`. */
  max?: string;
  placeholder?: string;
  className?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
  "aria-required"?: boolean | "true" | "false";
  "data-testid"?: string;
}

export const DateTimeField = React.forwardRef<
  HTMLInputElement,
  DateTimeFieldProps
>(function DateTimeField(
  {
    id,
    name,
    value,
    defaultValue,
    onChange,
    onBlur,
    disabled,
    required,
    min,
    max,
    placeholder,
    className,
    "aria-label": ariaLabel,
    "aria-describedby": ariaDescribedBy,
    "aria-invalid": ariaInvalid,
    "aria-required": ariaRequired,
    "data-testid": dataTestId,
    ...rest
  },
  forwardedRef,
) {
  const { locale, t } = useTranslations();
  const dateFormat = useDateFormatPreference();
  const timeFormat = useTimeFormatPreference();

  const innerRef = React.useRef<HTMLInputElement | null>(null);
  const setRefs = React.useCallback(
    (node: HTMLInputElement | null) => {
      innerRef.current = node;
      if (typeof forwardedRef === "function") forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    },
    [forwardedRef],
  );

  const [internal, setInternal] = React.useState(defaultValue ?? "");
  const local = value ?? internal;

  const display = formatLocalDateTime(local, dateFormat, timeFormat, locale);

  function commit(next: string) {
    if (value === undefined) setInternal(next);
    onChange?.(next);
  }

  function openPicker() {
    const el = innerRef.current;
    if (!el || disabled) return;
    try {
      (el as HTMLInputElement & { showPicker?: () => void }).showPicker?.();
    } catch {
      el.focus();
    }
  }

  return (
    <div
      className={cn(FIELD_BASE_CLASSES, FIELD_HEIGHT_CLASSES, className)}
      data-slot="date-time-field"
      data-disabled={disabled ? "" : undefined}
    >
      {/* Visually-hidden native datetime input — owns the real value + events. */}
      <input
        {...rest}
        ref={setRefs}
        id={id}
        name={name}
        type="datetime-local"
        lang={locale}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        value={value !== undefined ? value : undefined}
        defaultValue={value === undefined ? defaultValue : undefined}
        disabled={disabled}
        required={required}
        min={min}
        max={max}
        onChange={(e) => commit(e.target.value)}
      />
      {/* Read-only display overlay. */}
      <input
        type="text"
        readOnly
        autoComplete="off"
        data-testid={dataTestId}
        className="placeholder:text-muted-foreground h-full flex-1 cursor-default bg-transparent py-1 outline-none disabled:cursor-not-allowed"
        value={display}
        placeholder={placeholder ?? formatPlaceholder(dateFormat, locale)}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        aria-required={ariaRequired}
        onClick={openPicker}
        onFocus={openPicker}
        onBlur={onBlur}
      />
      <button
        type="button"
        tabIndex={-1}
        disabled={disabled}
        aria-label={t("common.openDatePicker")}
        className="text-muted-foreground hover:text-foreground flex h-8 w-8 shrink-0 items-center justify-center rounded-md disabled:cursor-not-allowed disabled:opacity-50"
        onClick={openPicker}
      >
        <Calendar className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
});

/**
 * Format a local `yyyy-MM-ddTHH:mm` string into "<date> <time>" where the
 * date part follows the date-order preference and the time part follows the
 * hour-cycle preference. The value is a wall-clock instant (no zone), so the
 * literal parts are read directly and rendered with `timeZone: "UTC"` to keep
 * the displayed clock identical to what the user typed. Returns "" for an
 * empty / malformed value so the field paints its placeholder.
 */
function formatLocalDateTime(
  value: string,
  dateFormat: ReturnType<typeof useDateFormatPreference>,
  timeFormat: ReturnType<typeof useTimeFormatPreference>,
  locale: ReturnType<typeof useTranslations>["locale"],
): string {
  const parts = parseLocalDateTime(value);
  if (!parts) return "";

  const datePart = formatDate(parts.date, dateFormat, locale);
  if (datePart === "") return "";

  // Anchor the wall-clock time in UTC so the rendered clock matches the typed
  // parts exactly, regardless of the viewer's timezone.
  const anchored = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute),
  );
  const timePart = anchored.toLocaleTimeString(
    resolveDateLocale(dateFormat, locale),
    {
      timeZone: "UTC",
      hour: "2-digit",
      minute: "2-digit",
      ...hourCycleOptions(timeFormat),
    },
  );

  return `${datePart} ${timePart}`;
}

/** Split a local `yyyy-MM-ddTHH:mm` string into its calendar parts. */
function parseLocalDateTime(value: string): {
  date: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  // Reject impossible component ranges so the field falls back to placeholder
  // rather than rendering an "Invalid Date".
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59
  ) {
    return null;
  }
  return { date: `${y}-${mo}-${d}`, year, month, day, hour, minute };
}

/** Placeholder that mirrors the active date order, e.g. "DD.MM.YYYY --:--". */
function formatPlaceholder(
  dateFormat: ReturnType<typeof useDateFormatPreference>,
  locale: ReturnType<typeof useTranslations>["locale"],
): string {
  const date = formatDate("2026-12-31", dateFormat, locale)
    .replace(/31/g, "DD")
    .replace(/12/g, "MM")
    .replace(/2026/g, "YYYY");
  return `${date} --:--`;
}
