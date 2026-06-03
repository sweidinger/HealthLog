/**
 * v1.11.0 — public clinician view (Epic C, C5).
 *
 * A standalone, read-only RSC at `/c/<token>`. It carries NO app chrome, NO
 * coach / AI / insight generation, and NO session — it is authenticated solely
 * by the unguessable `hls_` token in the path, resolved through the C3
 * {@link resolveShareToken} security core (the only trust boundary here).
 *
 * An unknown / revoked / expired / malformed token resolves to `null` and the
 * page answers a flat `notFound()` (404) — the same blunt response for every
 * failure class so a probe learns nothing.
 *
 * The descriptive wellness scores are fenced inside a muted card carrying the
 * load-bearing "not a clinical assessment / not a diagnosis" disclaimer. KVNR
 * is default OFF (never decrypted or shown here). No markdown anywhere — every
 * string renders as escaped React text children (XSS posture).
 */
import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";

import { resolveShareToken } from "@/lib/clinician-share/resolve-share-token";
import { loadShareViewData } from "@/lib/clinician-share/share-view-data";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import {
  defaultLocale,
  locales,
  type Locale,
} from "@/lib/i18n/config";
import { parseLocaleFromAcceptLanguage } from "@/lib/format-locale";
import { ClinicianView } from "@/components/clinician/clinician-view";

// Never cache a scoped health view — `no-store` end to end.
export const dynamic = "force-dynamic";
export const revalidate = 0;

// A shared clinical record must never be indexed.
export const metadata: Metadata = {
  title: "Shared health record",
  robots: { index: false, follow: false },
};

async function resolveLocale(): Promise<Locale> {
  try {
    const cookieStore = await cookies();
    const cookieLocale = cookieStore.get("healthlog-locale")?.value;
    if (cookieLocale && (locales as readonly string[]).includes(cookieLocale)) {
      return cookieLocale as Locale;
    }
    const headerList = await headers();
    return parseLocaleFromAcceptLanguage(headerList.get("accept-language"));
  } catch {
    return defaultLocale;
  }
}

export default async function ClinicianSharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  // The ONE trust boundary. No session is read; this proves only that the raw
  // path token hashes to a live, in-window share link and yields the owner
  // scope. Any failure → null → flat 404.
  const context = await resolveShareToken(token);
  if (!context) notFound();

  const [{ report, sections }, locale] = await Promise.all([
    loadShareViewData(context),
    resolveLocale(),
  ]);
  const { t } = getServerTranslator(locale);

  return (
    <ClinicianView
      t={(key, vars) => t(key, vars)}
      label={context.label}
      expiresAt={context.expiresAt.toISOString()}
      report={report}
      sections={sections}
    />
  );
}
