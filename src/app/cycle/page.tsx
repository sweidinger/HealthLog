"use client";

import { Suspense, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { CycleView } from "@/components/cycle/cycle-view";

/**
 * v1.15.0 — the cycle vertical entry.
 *
 * Gated on `cycleTrackingEnabled` from `GET /api/auth/me` (resolved
 * server-side from gender + the per-user opt-in). An unauthenticated visitor
 * is bounced to login; an authenticated account without the feature enabled
 * is bounced home (the nav entry is already hidden for them, so this only
 * catches a direct URL hit). Every `/api/cycle/*` route also enforces the
 * gate server-side, so this is a UX redirect, not the security boundary.
 */
export default function CyclePage() {
  const { user, isLoading, isAuthenticated } = useAuth();
  const router = useRouter();

  const enabled = user?.cycleTrackingEnabled === true;

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

  // `<CycleView>` reads `useSearchParams` for the `?tab=` deep-link; wrap it in
  // a Suspense boundary so the client-search-params bailout never de-opts the
  // build (Next's `missing-suspense-with-csr-bailout`).
  return (
    <Suspense
      fallback={
        <div className="flex h-64 items-center justify-center">
          <Loader2 className="text-primary h-8 w-8 animate-spin motion-reduce:animate-none" />
        </div>
      }
    >
      <CycleView />
    </Suspense>
  );
}
