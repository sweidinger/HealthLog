import { NextResponse } from "next/server";

import { locales, type Locale } from "@/lib/i18n/config";
import { allMessages } from "@/lib/i18n/shared-resolve";

/**
 * Locale-catalog boot script.
 *
 * The root layout emits `<script src="/i18n/<locale>?v=<version>" defer>`
 * ahead of Next's hydration scripts. The body assigns the active locale's
 * full message bundle to `self.__HL_I18N`, which `load-locale.ts` reads in
 * its browser cache initializer — so the first client render holds the same
 * strings the server rendered with.
 *
 * This replaces the former RSC-prop handoff that serialized the ENTIRE
 * active catalog into every document's flight payload (392 KB of a 505 KB
 * dashboard HTML, re-downloaded on every hard load). As a versioned URL the
 * catalog is immutable-cacheable: one download per deploy per locale, then
 * HTTP/SW cache. The `?v=` query is only a cache key; the handler always
 * serves the catalog baked into the running build.
 *
 * Public by design (allowlisted in `src/proxy.ts`): the login page needs it
 * pre-auth, and the catalogs are the same strings that ship in the public
 * repository — no tenant data, no secrets.
 */

const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ locale: string }> },
) {
  const { locale } = await params;
  if (!(locales as readonly string[]).includes(locale)) {
    return new NextResponse(null, { status: 404 });
  }

  const payload = JSON.stringify({
    locale,
    messages: allMessages[locale as Locale],
  });
  return new NextResponse(`self.__HL_I18N = ${payload};`, {
    status: 200,
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": IMMUTABLE_CACHE,
      // Belt and suspenders for a script-typed response.
      "X-Content-Type-Options": "nosniff",
    },
  });
}
