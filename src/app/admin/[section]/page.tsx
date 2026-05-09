import { notFound } from "next/navigation";

import { AdminShell } from "@/components/admin/admin-shell";
import { AdminSectionRenderer } from "./renderer";
import {
  ADMIN_SECTION_SLUGS,
  isAdminSectionSlug,
} from "@/components/admin/section-slugs";

/**
 * Dynamic admin section route — mirrors the v1.4 settings split. Each of
 * the `ADMIN_SECTION_SLUGS` is pre-rendered at build via
 * `generateStaticParams()` so the URLs are statically known to Next.js,
 * while `dynamicParams = false` tells the router to 404 (rather than
 * attempting on-demand rendering) for any slug not in the list.
 *
 * The actual section components are mounted by the client-only
 * `<AdminSectionRenderer>` because most of them use TanStack Query and
 * the auth hook (server-rendered they'd just paint a loader). The shell,
 * however, is server-rendered so the sidebar paints with no JS hydration
 * lag.
 */

export const dynamicParams = false;

export function generateStaticParams() {
  return ADMIN_SECTION_SLUGS.map((section) => ({ section }));
}

interface PageProps {
  // Next.js 16 made route `params` an async Promise. We `await` it before use.
  params: Promise<{ section: string }>;
}

export default async function AdminSectionPage({ params }: PageProps) {
  const { section } = await params;

  // Defence-in-depth — `dynamicParams = false` already 404s unknown slugs at
  // routing time, but we re-check here so a hand-rolled override of the
  // route config can never silently fall through to a typo'd slug.
  if (!isAdminSectionSlug(section)) {
    notFound();
  }

  return (
    <AdminShell active={section}>
      <AdminSectionRenderer slug={section} />
    </AdminShell>
  );
}
