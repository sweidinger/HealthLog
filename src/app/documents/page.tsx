"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { InboundDocumentsView } from "@/components/documents/inbound-documents-view";

/**
 * v1.25.0 (W-DOCS-IN) — inbound clinical documents entry.
 *
 * Born-gated on the resolved `modules.inboundDocuments` flag from
 * `GET /api/auth/me` (opt-in / default-off — the per-user opt-in AND the
 * operator server-wide kill-switch). An unauthenticated visitor is bounced to
 * login; an authenticated account without the module opted in is bounced home
 * (the nav entry is already hidden for them, so this only catches a direct URL
 * hit). Every `/api/documents/inbound/*` route also enforces the gate
 * server-side, so this is a UX redirect, not the security boundary.
 */
export default function DocumentsPage() {
  const { user, isLoading, isAuthenticated } = useAuth();
  const router = useRouter();

  const enabled = user?.modules?.inboundDocuments === true;

  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated) {
      router.push("/auth/login");
    } else if (!enabled) {
      router.push("/");
    }
  }, [isLoading, isAuthenticated, enabled, router]);

  if (isLoading || !isAuthenticated || !enabled) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="text-primary h-8 w-8 animate-spin motion-reduce:animate-none" />
      </div>
    );
  }

  return <InboundDocumentsView />;
}
