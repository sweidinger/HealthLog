/**
 * PUT /api/auth/me/locale
 *
 * v1.25.0 — persist the user's UI locale onto `User.locale`.
 *
 * The language switcher historically wrote the choice to localStorage,
 * the `healthlog-locale` cookie and `<html lang>` ONLY — never to the
 * user row. Server-side background work (the proactive Coach nudge, the
 * Telegram test message, …) has no request cookie to read, so it falls
 * back to `User.locale`; with the column left null those messages went
 * out in English regardless of the language the user reads the app in.
 *
 * This setter closes the gap: the client persists the active locale here
 * (on every switch, plus a one-time backfill on mount) so the column
 * reliably mirrors the UI language and the cron paths render in it.
 *
 * Auth: cookie session OR Bearer token.
 * Validation: `{ "locale": "de" }` — must be one of the supported
 * locales; anything else is rejected at the surface so the column never
 * holds a value the resolver would later have to defend against.
 */
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, safeJson } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { locales, type Locale } from "@/lib/i18n/config";

export const dynamic = "force-dynamic";

function isLocale(value: unknown): value is Locale {
  return (
    typeof value === "string" && (locales as readonly string[]).includes(value)
  );
}

export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "user.locale.update" } });

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 4 * 1024,
  });
  if (jsonError) return jsonError;

  const locale = (body as { locale?: unknown } | null)?.locale;
  if (!isLocale(locale)) {
    return apiError("Not a supported locale.", 422);
  }

  // Idempotent: skip the write (and the annotation noise) when the column
  // already matches — the mount-time backfill fires on every page load.
  if (user.locale !== locale) {
    await prisma.user.update({
      where: { id: user.id },
      data: { locale },
    });
    annotate({ meta: { locale_next: locale } });
  }

  return apiSuccess({ locale });
});
