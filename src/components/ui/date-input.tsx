"use client";

import * as React from "react";

import { Input } from "@/components/ui/input";
import { useTranslations } from "@/lib/i18n/context";

/**
 * Native date input that hints the active locale via `lang=`. Browsers
 * use this hint to render the calendar widget in dd.MM.yyyy / MM/dd/yyyy
 * order, which is the user-visible format we want to follow the app's
 * EN/DE preference. Wrapping the prop here keeps every callsite from
 * having to pull `locale` out of `useTranslations()` just to feed it
 * back into the same JSX prop, and guarantees a future date input
 * cannot silently regress by forgetting the hint.
 */
type InputProps = React.ComponentProps<typeof Input>;
type DateInputProps = Omit<InputProps, "type" | "lang">;

export function DateInput(props: DateInputProps) {
  const { locale } = useTranslations();
  return <Input type="date" lang={locale} {...props} />;
}

export function DateTimeInput(props: DateInputProps) {
  const { locale } = useTranslations();
  return <Input type="datetime-local" lang={locale} {...props} />;
}
