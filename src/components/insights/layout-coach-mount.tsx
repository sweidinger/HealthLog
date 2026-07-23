"use client";

import dynamic from "next/dynamic";

import { useCoachLaunch } from "@/lib/insights/coach-launch-context";
import { useFeatureFlags } from "@/hooks/use-feature-flags";
import { useDisableCoach } from "@/hooks/use-disable-coach";

/**
 * v1.4.31 — defer the Coach drawer subtree behind `next/dynamic` so
 * the SSE machinery (chat reader, suggested-prompts chip rail,
 * source-chip thread, persistent settings sheet) doesn't load on
 * every cold /insights mount. The drawer renders nothing until the
 * user opens it, but the legacy direct import still ran every
 * `useState` initialiser + the Sheet portal scaffolding inside the
 * mother-page render window. Per
 * `.planning/research/v15-insights-blocking-bug.md` fix 4.
 */
const CoachDrawer = dynamic(
  () =>
    import("@/components/insights/coach-panel/coach-drawer").then((mod) => ({
      default: mod.CoachDrawer,
    })),
  { ssr: false, loading: () => null },
);

/**
 * v1.4.27 R3d MB4 — bridge between the layout-level
 * `<CoachLaunchProvider>` and the Coach drawer mount.
 *
 * The layout file is a server component (it lives next to other server
 * components and feeds the `metadata` chain), so the actual `useState`
 * + `<CoachDrawer>` consumer has to live inside a client island. This
 * file is intentionally tiny — its only job is to read the context and
 * render the drawer at the layout's mount site.
 */
export function LayoutCoachMount() {
  const launch = useCoachLaunch();
  const flags = useFeatureFlags();
  const disableCoach = useDisableCoach();
  if (!launch) return null;
  // v1.4.31 — operator can hide the Coach drawer app-wide; suppress
  // the entire SSE mount when the flag is off.
  if (!flags.coach) return null;
  // v1.4.47 W3 — per-user opt-out short-circuits the drawer subtree
  // the same way the operator's master flag does. Keeps the SSE
  // chat reader + portal scaffolding out of the bundle for users
  // who never want the Coach mounted.
  if (disableCoach) return null;
  return (
    <CoachDrawer
      open={launch.open}
      onOpenChange={launch.setOpen}
      prefill={launch.prefill}
      // v1.21.0 (C4 H1/H4) — carry the launch scope so a conversation
      // opened from a metric surface or insight card is pre-narrowed to
      // the relevant source(s).
      scope={launch.scope}
      // Auto-send the prefill as the first turn when the launch requested it
      // (assessment hand-off), so the answer lands without a manual send.
      autoSend={launch.autoSend}
      // v1.28.52 (Documents R3) — carry the stored-document scope so the vault
      // "Ask the Coach" action opens the REAL fenced conversation in the drawer
      // scoped to that document (maximizing then preserves the scope).
      documentId={launch.documentId}
      // v1.31.0 — carry the workout scope so the workout-detail "Ask why"
      // action opens a conversation whose first turn reads that session's own
      // numbers.
      workoutId={launch.workoutId}
    />
  );
}
