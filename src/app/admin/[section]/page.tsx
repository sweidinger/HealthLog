import { notFound } from "next/navigation";

import { AdminShell } from "@/components/admin/admin-shell";
import { AdminSectionRenderer } from "./renderer";
import {
  ADMIN_SECTION_SLUGS,
  isAdminSectionSlug,
} from "@/components/admin/section-slugs";

// Section bodies need TanStack Query / useAuth, so they're rendered by the
// client-only `<AdminSectionRenderer>`. The shell stays server-rendered.

export const dynamicParams = false;

export function generateStaticParams() {
  return ADMIN_SECTION_SLUGS.map((section) => ({ section }));
}

interface PageProps {
  params: Promise<{ section: string }>;
}

export default async function AdminSectionPage({ params }: PageProps) {
  const { section } = await params;

  if (!isAdminSectionSlug(section)) {
    notFound();
  }

  return (
    <AdminShell active={section}>
      <AdminSectionRenderer slug={section} />
    </AdminShell>
  );
}
