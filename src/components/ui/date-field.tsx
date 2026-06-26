"use client";

import * as React from "react";
import { Calendar } from "lucide-react";

import { cn } from "@/lib/utils";
import { useTranslations, useDateFormatPreference } from "@/lib/i18n/context";
import { formatDate, parseIsoDate } from "@/lib/date-format";

/**
 * Dependency-free date input that DISPLAYS the value in the user's date-order
 * preference (AUTO follows the locale; DMY / MDY / YMD pin the field order)
 * while editing rides the browser's native date picker.
 *
 * The committed VALUE is always ISO `yyyy-MM-dd` — identical to the native
 * `<input type="date">` contract `<DateInput>` ships — so this is a drop-in
 * for `<DateInput>` and existing react-hook-form wiring is unchanged.
 *
 * How it works:
 *   - A visually-hidden native `<input type="date">` holds the real value and
 *     emits the change events the form listens to. Tapping the field (or its
 *     calendar button) calls `showPicker()` on that input, falling back to
 *     `focus()` where the API is unavailable.
 *   - A text overlay paints the formatted display string (or the placeholder).
 *   - As a progressive enhancement the user can type a date directly: the
 *     overlay is an editable text input; on blur / Enter we parse what they
 *     typed against the active locale order and, on a clean parse, write the
 *     ISO value back through the hidden input so the form sees a normal change.
 *
 * Height / a11y / target-size parity with `<DateInput>`: the same
 * `min-h-11 h-11 sm:min-h-10 sm:h-10` floor (WCAG 2.5.5 — 44 px on mobile,
 * 40 px on sm+) and focus vocabulary as the rest of the input primitives.
 */

// Mirrors the `<DateInput>` height contract (minus the date-shadow rule, which
// only applies to the native value text — here the native input is hidden).
const FIELD_HEIGHT_CLASSES = "min-h-11 h-11 sm:min-h-10 sm:h-10";

const FIELD_BASE_CLASSES =
  "border-input bg-background text-foreground ring-offset-background placeholder:text-muted-foreground focus-within:ring-ring relative flex w-full items-center rounded-md border ps-3 pe-2 text-sm shadow-xs transition-[color,box-shadow] focus-within:ring-2 focus-within:ring-offset-2 focus-within:outline-none";

export interface DateFieldProps {
  id?: string;
  name?: string;
  /** ISO `yyyy-MM-dd` (controlled). */
  value?: string;
  /** Initial ISO `yyyy-MM-dd` (uncontrolled). */
  defaultValue?: string;
  onChange?: (value: string) => void;
  onBlur?: () => void;
  disabled?: boolean;
  required?: boolean;
  /** Autofill hint forwarded to the native date input (e.g. "bday"). */
  autoComplete?: string;
  /** ISO `yyyy-MM-dd`. */
  min?: string;
  /** ISO `yyyy-MM-dd`. */
  max?: string;
  placeholder?: string;
  className?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
  "data-testid"?: string;
}

export const DateField = React.forwardRef<HTMLInputElement, DateFieldProps>(
  function DateField(
    {
      id,
      name,
      value,
      defaultValue,
      onChange,
      onBlur,
      disabled,
      required,
      autoComplete,
      min,
      max,
      placeholder,
      className,
      "aria-label": ariaLabel,
      "aria-describedby": ariaDescribedBy,
      "aria-invalid": ariaInvalid,
      "data-testid": dataTestId,
      ...rest
    },
    forwardedRef,
  ) {
    const { locale, t } = useTranslations();
    const dateFormat = useDateFormatPreference();

    const innerRef = React.useRef<HTMLInputElement | null>(null);
    const setRefs = React.useCallback(
      (node: HTMLInputElement | null) => {
        innerRef.current = node;
        if (typeof forwardedRef === "function") forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      },
      [forwardedRef],
    );

    // Track the ISO value so the overlay reflects controlled + uncontrolled
    // updates. Controlled `value` always wins on render.
    const [internal, setInternal] = React.useState(defaultValue ?? "");
    const iso = value ?? internal;

    // Mirror what the user is typing into the overlay; cleared back to the
    // formatted string whenever the committed ISO value changes.
    const [typed, setTyped] = React.useState<string | null>(null);

    const display = formatDate(iso, dateFormat, locale);
    const overlayValue = typed ?? display;

    function commitIso(next: string) {
      if (value === undefined) setInternal(next);
      setTyped(null);
      onChange?.(next);
    }

    function openPicker() {
      const el = innerRef.current;
      if (!el || disabled) return;
      // showPicker() throws if not user-activated or unsupported — fall back
      // to focusing the (hidden) input, which still opens the picker on most
      // mobile engines.
      try {
        (el as HTMLInputElement & { showPicker?: () => void }).showPicker?.();
      } catch {
        el.focus();
      }
    }

    function handleNativeChange(e: React.ChangeEvent<HTMLInputElement>) {
      commitIso(e.target.value);
    }

    // Progressive enhancement: parse free-typed text against the active locale
    // order. We feed the typed string to the browser's own parser via a throw-
    // away Date only when it matches the ISO shape; otherwise we accept a small
    // set of separator-flexible numeric forms keyed off the preference.
    function commitTyped() {
      if (typed === null) return;
      const trimmed = typed.trim();
      if (trimmed === "") {
        commitIso("");
        return;
      }
      const parsed = parseTypedDate(trimmed, dateFormat, locale);
      if (parsed) {
        commitIso(parsed);
      } else {
        // Unparseable — discard the draft and snap back to the committed value.
        setTyped(null);
      }
    }

    return (
      <div
        className={cn(FIELD_BASE_CLASSES, FIELD_HEIGHT_CLASSES, className)}
        data-slot="date-field"
        data-disabled={disabled ? "" : undefined}
      >
        {/* Visually-hidden native date input — owns the real value + events. */}
        <input
          {...rest}
          ref={setRefs}
          id={id}
          name={name}
          type="date"
          lang={locale}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          value={value !== undefined ? value : undefined}
          defaultValue={value === undefined ? defaultValue : undefined}
          disabled={disabled}
          required={required}
          autoComplete={autoComplete}
          min={min}
          max={max}
          onChange={handleNativeChange}
        />
        {/* Editable display overlay. */}
        <input
          type="text"
          inputMode="numeric"
          autoComplete="off"
          data-testid={dataTestId}
          className="placeholder:text-muted-foreground h-full flex-1 bg-transparent py-1 outline-none disabled:cursor-not-allowed"
          value={overlayValue}
          placeholder={placeholder ?? formatPlaceholder(dateFormat, locale)}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-describedby={ariaDescribedBy}
          aria-invalid={ariaInvalid}
          onChange={(e) => setTyped(e.target.value)}
          onClick={openPicker}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitTyped();
            }
          }}
          onBlur={() => {
            commitTyped();
            onBlur?.();
          }}
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
  },
);

/** Placeholder that mirrors the active field order, e.g. "DD.MM.YYYY". */
function formatPlaceholder(
  dateFormat: ReturnType<typeof useDateFormatPreference>,
  locale: ReturnType<typeof useTranslations>["locale"],
): string {
  // 2026-12-31 renders unambiguously in every order, so its formatted shape
  // doubles as a self-describing placeholder hint.
  return formatDate("2026-12-31", dateFormat, locale)
    .replace(/31/g, "DD")
    .replace(/12/g, "MM")
    .replace(/2026/g, "YYYY");
}

/**
 * Best-effort parse of a free-typed date into ISO `yyyy-MM-dd`. Accepts the
 * active preference's field order with `.`, `/`, or `-` separators, plus a
 * bare ISO string. Returns null when the parts don't form a real calendar
 * date so the caller can reject the draft.
 */
function parseTypedDate(
  input: string,
  dateFormat: ReturnType<typeof useDateFormatPreference>,
  locale: ReturnType<typeof useTranslations>["locale"],
): string | null {
  // A clean ISO string always wins.
  const isoDirect = parseIsoDate(input);
  if (isoDirect) return toIso(isoDirect);

  const parts = input.split(/[./-]/).map((p) => p.trim());
  if (parts.length !== 3 || parts.some((p) => p === "" || !/^\d+$/.test(p))) {
    return null;
  }
  const nums = parts.map(Number) as [number, number, number];

  const order = resolveOrder(dateFormat, locale);
  let year: number, month: number, day: number;
  if (order === "MDY") [month, day, year] = nums;
  else if (order === "YMD") [year, month, day] = nums;
  else [day, month, year] = nums; // DMY

  if (year < 100) year += year >= 70 ? 1900 : 2000;
  const candidate = `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
  const round = parseIsoDate(candidate);
  return round ? candidate : null;
}

function resolveOrder(
  dateFormat: ReturnType<typeof useDateFormatPreference>,
  locale: ReturnType<typeof useTranslations>["locale"],
): "DMY" | "MDY" | "YMD" {
  if (dateFormat === "DMY") return "DMY";
  if (dateFormat === "MDY") return "MDY";
  if (dateFormat === "YMD") return "YMD";
  // AUTO: en → MDY, every other shipped locale → DMY.
  return locale === "en" ? "MDY" : "DMY";
}

function toIso(date: Date): string {
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(
    date.getUTCDate(),
    2,
  )}`;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}
