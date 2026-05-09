"use client";

/**
 * v1.4.15 Phase B5 — onboarding-tour launcher.
 *
 * Decides *when* to start the spotlight tour. Mounted on the
 * dashboard; opens the tour exactly once for new users and never
 * again unless they explicitly request a replay from
 * Settings → Account.
 *
 * Gating rules:
 *
 *   1. Wait until the auth payload (`/api/auth/me`) has resolved so
 *      we know `onboardingTourCompleted`.
 *   2. Wait until the dashboard's analytics fetch has resolved.
 *      The tour spotlights the tile strip — if we open before tiles
 *      have rendered, the cutout snaps to a 0×0 invisible target
 *      and the tooltip fallbacks to centre-screen, breaking the
 *      first impression. The launcher subscribes to the same
 *      `["analytics"]` query the dashboard uses; the data resolves
 *      synchronously on subsequent visits via the React Query cache.
 *   3. Don't auto-launch within 1500ms of the user navigating away
 *      from `/onboarding`. The wizard ends with a green-tick toast
 *      that overlaps the same z-index range; if the tour pops up
 *      mid-toast it reads as a double overlay.
 *   4. Honour a localStorage dismiss flag for the *current session*.
 *      Mostly defensive — when the API call to flip the DB flag
 *      races with an in-flight `/api/auth/me` refetch, the cached
 *      response could re-open the tour. The localStorage guard
 *      blocks that for the rest of the session.
 *
 * Replay flow: the Settings → Account "Restart" button posts
 * `{ completed: false }` to /api/onboarding/tour, then dispatches a
 * `healthlog:tour-restart` window event. This launcher listens for
 * that event and force-opens the tour without reading the flag —
 * convenient because invalidating the auth cache + waiting for the
 * round-trip would feel laggy.
 */

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useAuth } from "@/hooks/use-auth";
import { OnboardingTour } from "./tour";

const POST_WIZARD_GRACE_MS = 1500;

// v1.4.15 H4 — sessionStorage keys are now scoped by user id so an
// admin impersonating a second user does not inherit the first user's
// "tour dismissed for this session" state. The previous global keys
// (`healthlog-tour-session-dismissed`, `healthlog-tour-referrer`)
// kept v1.4.16's multi-tenant prep clean too: anyone using the same
// browser to switch accounts via the typical user-menu sign-out flow
// will not see the tour suppressed under their second identity.
//
// Exported for the unit-test suite so the key-construction stays
// pinned across refactors (and so the keys themselves stay stable —
// changing them would re-fire the tour for everyone).
export function tourSessionDismissedKey(userId: string): string {
  return `healthlog-tour-session-dismissed:${userId}`;
}

export function tourReferrerKey(userId: string): string {
  return `healthlog-tour-referrer:${userId}`;
}

/**
 * Whether the user just navigated here from `/onboarding`. Read
 * once at mount via a `useState` lazy initialiser (which runs in a
 * pure-by-contract slot, not the render body) — see the
 * `useState(() => …)` call in `<TourLauncher>`. The wizard's
 * `persistAndExit()` writes `"1"` into sessionStorage immediately
 * before navigating, and the launcher consumes-and-clears it on
 * first mount so a back-button to the wizard and forward again
 * doesn't double-defer.
 *
 * `userId` is required — until the auth payload arrives the launcher
 * does not consult sessionStorage at all (the gating effect waits
 * for `inputsReady` first).
 */
function readAndClearJustFromWizard(userId: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const key = tourReferrerKey(userId);
    const value = window.sessionStorage.getItem(key);
    if (value !== "1") return false;
    window.sessionStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function readSessionDismissed(userId: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return (
      window.sessionStorage.getItem(tourSessionDismissedKey(userId)) === "1"
    );
  } catch {
    return false;
  }
}

function writeSessionDismissed(userId: string) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(tourSessionDismissedKey(userId), "1");
  } catch {
    /* ignore — sandboxed iframes etc. */
  }
}

function clearSessionDismissed(userId: string) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(tourSessionDismissedKey(userId));
  } catch {
    /* ignore */
  }
}

interface TourLauncherProps {
  /**
   * The dashboard passes a sentinel — true once analytics has
   * resolved at least once. Without this gate the spotlight would
   * try to anchor to tiles that haven't rendered yet, and Recharts
   * widgets defer mounting too. This is a simple, race-free signal
   * the dashboard already computes.
   */
  ready: boolean;
}

export function TourLauncher({ ready }: TourLauncherProps) {
  const { user, isAuthenticated, isLoading } = useAuth();
  const queryClient = useQueryClient();

  // `null` = decision not yet made; `true` = render the tour;
  // `false` = don't render. We only flip null→true ONCE per mount;
  // closing the tour transitions true→false and we never re-open
  // unless the restart event fires.
  const [showTour, setShowTour] = useState<boolean | null>(null);
  // Track post-wizard deferral as a boolean so the render path stays
  // pure (no Date.now() comparisons). The effect below reads / clears it.
  const [deferredFromWizard, setDeferredFromWizard] = useState(false);
  // Tracks the (userId, flag) tuple the launch-decision evaluator
  // has already run for. The render-phase decision below uses this
  // as the React-recommended "previous input id" guard so the
  // setState block runs at most once per (user, flag) transition.
  const [decidedFor, setDecidedFor] = useState<{
    userId: string;
    flag: boolean;
  } | null>(null);

  const inputsReady = !isLoading && isAuthenticated && !!user && ready;
  // The set-state-in-render pattern (mirrors `account-section.tsx`'s
  // `seededUserId` — React-recommended for "compute initial state
  // from props once they arrive"). Pure: branches on prop values
  // and constant-result helpers only.
  if (
    showTour === null &&
    inputsReady &&
    user &&
    (decidedFor === null ||
      decidedFor.userId !== user.id ||
      decidedFor.flag !== user.onboardingTourCompleted)
  ) {
    setDecidedFor({ userId: user.id, flag: user.onboardingTourCompleted });
    // sessionStorage reads happen via per-user keyed helpers, so a
    // browser shared by two HealthLog users (admin impersonation,
    // family laptop, etc.) keeps each user's tour state independent.
    if (user.onboardingTourCompleted) {
      setShowTour(false);
    } else if (readSessionDismissed(user.id)) {
      setShowTour(false);
    } else if (readAndClearJustFromWizard(user.id)) {
      // Mark "deferred"; the effect below schedules a fixed-duration
      // timer + flips `showTour` from inside the timeout callback
      // (which the set-state-in-effect rule allows).
      setShowTour(false);
      setDeferredFromWizard(true);
    } else {
      setShowTour(true);
    }
  }

  // Wait out the post-wizard grace window. Side-effect-only (timer
  // management); the inner setState lives inside a callback so the
  // set-state-in-effect rule is satisfied.
  useEffect(() => {
    if (!deferredFromWizard) return;
    const userId = user?.id;
    if (!userId) return;
    const id = window.setTimeout(() => {
      if (!readSessionDismissed(userId)) {
        setShowTour(true);
      }
      setDeferredFromWizard(false);
    }, POST_WIZARD_GRACE_MS);
    return () => window.clearTimeout(id);
  }, [deferredFromWizard, user?.id]);

  // Listen for explicit restart events from Settings → Account.
  // setState inside a window-event listener is fine under the
  // set-state-in-effect rule.
  const userIdForRestart = user?.id;
  useEffect(() => {
    function onRestart() {
      if (userIdForRestart) clearSessionDismissed(userIdForRestart);
      setShowTour(true);
    }
    window.addEventListener("healthlog:tour-restart", onRestart);
    return () => {
      window.removeEventListener("healthlog:tour-restart", onRestart);
    };
  }, [userIdForRestart]);

  if (showTour !== true) return null;

  return (
    <OnboardingTour
      onClose={async (outcome) => {
        // Optimistic: hide the overlay immediately, persist in the
        // background. The flag is idempotent so re-fires are safe;
        // a network error here is non-fatal because the
        // session-dismiss guard prevents the tour from re-launching
        // for the rest of the session, and the next refetch of
        // `/api/auth/me` (which the user gets on any nav) will
        // surface any divergence.
        setShowTour(false);
        if (user?.id) writeSessionDismissed(user.id);
        try {
          await fetch("/api/onboarding/tour", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ completed: true, outcome }),
          });
          await queryClient.invalidateQueries({ queryKey: ["auth"] });
        } catch {
          // Swallow — the session-dismiss flag prevents a re-open.
          // Next visit will retry via the same code path.
        }
      }}
    />
  );
}
