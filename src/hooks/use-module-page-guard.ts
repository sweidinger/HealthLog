"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { useAuth } from "@/hooks/use-auth";
import type { ModuleKey } from "@/lib/modules/registry";

/**
 * v1.18.0 B1 — client-side page guard for a toggleable module.
 *
 * Mirrors the cycle page (`src/app/cycle/page.tsx`): an unauthenticated
 * visitor bounces to login; an authenticated account without the module
 * enabled bounces to `/insights`. The nav entry is already hidden for a
 * disabled account, so this only catches a direct URL hit. Every backing
 * `/api/*` route enforces the gate server-side, so this is a UX redirect,
 * not the security boundary.
 *
 * Returns `ready` — `true` only once auth has resolved, the visitor is
 * authenticated, AND the module is enabled. While `false` the caller
 * should render a calm loader / nothing rather than the (about-to-
 * redirect) module surface, so a disabled-module page never half-renders.
 *
 * Default-on (disabled allowlist): an absent map, a missing key, or any
 * non-`false` value reads as enabled — matching the server gate.
 */
export function useModulePageGuard(moduleKey: ModuleKey): {
  ready: boolean;
} {
  const { user, isLoading, isAuthenticated } = useAuth();
  const router = useRouter();

  const enabled = user?.modules?.[moduleKey] !== false;

  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated) {
      router.push("/auth/login");
    } else if (!enabled) {
      router.push("/insights");
    }
  }, [isLoading, isAuthenticated, enabled, router]);

  return { ready: !isLoading && isAuthenticated && enabled };
}
