"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { IllnessView } from "@/components/illness/illness-view";

/**
 * v1.18.1 — the illness / condition-journal entry.
 *
 * Born-gated on the resolved `modules.illness` flag from `GET /api/auth/me`
 * (opt-in / default-off; the per-user opt-in AND the operator server-wide
 * kill-switch). An unauthenticated visitor is bounced to login; an
 * authenticated account without the module opted in is bounced home (the
 * nav entry is already hidden for them, so this only catches a direct URL
 * hit). Every `/api/illness/*` route also enforces the gate server-side,
 * so this is a UX redirect, not the security boundary.
 */
export default function IllnessPage() {
  const { user, isLoading, isAuthenticated } = useAuth();
  const router = useRouter();

  // Born-gated: enabled ONLY when the resolved map says `true`.
  const enabled = user?.modules?.illness === true;

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

  return <IllnessView />;
}
