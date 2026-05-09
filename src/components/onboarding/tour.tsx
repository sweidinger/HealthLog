"use client";

/**
 * v1.4.15 Phase B5 — onboarding spotlight tour.
 *
 * After a new user finishes the wizard at `/onboarding` and lands on
 * the dashboard, this overlay walks them through 4–5 key features
 * (tile strip, quick-add menu, insights, integrations, achievements).
 *
 * Architecture decisions:
 * - **No new dependency.** Project package.json carries no
 *   `react-joyride`/`intro.js`/`shepherd` already, and the tour is
 *   small enough that an in-house spotlight + tooltip is preferable
 *   to a 30 KB add. We render a fixed full-viewport overlay with a
 *   dark backdrop and one rectangular cutout aligned to the live
 *   target via measured `getBoundingClientRect()`. The tooltip is
 *   absolutely positioned next to the cutout.
 * - **`data-tour-id` not class names.** Targets are looked up by a
 *   stable data attribute that's not affected by Tailwind churn.
 *   Each target's location is re-measured on `resize` and `scroll`
 *   so the cutout follows the element.
 * - **Graceful degradation.** If the target element is missing
 *   (mobile breakpoint, conditional render), we drop the cutout and
 *   render the tooltip centred on screen so the user can still
 *   advance through the tour.
 * - **Accessibility:** the dialog uses `role="dialog"` +
 *   `aria-modal="true"` + `aria-labelledby`, focus moves to the
 *   primary action on every step, ESC = skip, Tab is trapped inside
 *   the tooltip, and a live region announces the step transition.
 *   `prefers-reduced-motion` disables the cutout fade.
 *
 * The component is mounted by a sibling launcher that decides *when*
 * to start the tour (server flag + localStorage). This component
 * itself is dumb — caller hands it `onClose` (called on Skip OR Done)
 * plus `outcome` (so the launcher can persist `completed` vs
 * `skipped` to the API + audit log).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";
import {
  buildTourStops,
  currentStop,
  initTourState,
  isTourFinished,
  nextStep,
  prevStep,
  skipTour,
  stepCounter,
  type TourStop,
} from "@/lib/onboarding/tour-state";

interface TourProps {
  /**
   * Whether the achievements page exists and should be a tour stop.
   * The launcher passes `false` if B4 hasn't shipped to skip the
   * stop without renumbering.
   */
  includeAchievements?: boolean;
  /**
   * Called when the tour finishes (Done OR Skip OR Esc OR Backdrop
   * click). Receives the terminal outcome so the launcher can audit
   * the difference.
   */
  onClose: (outcome: "completed" | "skipped") => void;
}

interface SpotlightRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * Re-measure the target element. Returns `null` if the element is
 * not in the DOM or has zero dimensions — caller renders a centred
 * tooltip in that case.
 */
function measureTarget(targetId: string | null): SpotlightRect | null {
  if (!targetId) return null;
  if (typeof document === "undefined") return null;
  const el = document.querySelector<HTMLElement>(
    `[data-tour-id="${CSS.escape(targetId)}"]`,
  );
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  // Pad the cutout slightly so the highlight isn't flush against
  // the target's text.
  const PAD = 8;
  return {
    top: rect.top - PAD,
    left: rect.left - PAD,
    width: rect.width + PAD * 2,
    height: rect.height + PAD * 2,
  };
}

/**
 * Decide tooltip position. The intent is to sit beside the target
 * along the requested axis, but flip to the opposite edge if there
 * isn't enough room. Returns absolute viewport coordinates that the
 * UI uses with `position: fixed`. Falls back to centred when there
 * is no spotlight rect.
 */
function computeTooltipPosition(
  rect: SpotlightRect | null,
  placement: TourStop["placement"],
  tooltipSize: { width: number; height: number },
): { top: number; left: number; placement: TourStop["placement"] } {
  if (typeof window === "undefined") return { top: 0, left: 0, placement };
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (!rect) {
    return {
      top: Math.max(16, (vh - tooltipSize.height) / 2),
      left: Math.max(16, (vw - tooltipSize.width) / 2),
      placement: "center",
    };
  }
  const GAP = 12;
  const candidates: Array<{
    placement: TourStop["placement"];
    top: number;
    left: number;
  }> = [];

  if (placement === "bottom" || placement === "top" || placement === "center") {
    candidates.push({
      placement: "bottom",
      top: rect.top + rect.height + GAP,
      left: Math.min(
        Math.max(16, rect.left + rect.width / 2 - tooltipSize.width / 2),
        vw - tooltipSize.width - 16,
      ),
    });
    candidates.push({
      placement: "top",
      top: rect.top - tooltipSize.height - GAP,
      left: Math.min(
        Math.max(16, rect.left + rect.width / 2 - tooltipSize.width / 2),
        vw - tooltipSize.width - 16,
      ),
    });
  }
  if (placement === "right" || placement === "left") {
    candidates.push({
      placement: "right",
      top: Math.min(
        Math.max(16, rect.top + rect.height / 2 - tooltipSize.height / 2),
        vh - tooltipSize.height - 16,
      ),
      left: rect.left + rect.width + GAP,
    });
    candidates.push({
      placement: "left",
      top: Math.min(
        Math.max(16, rect.top + rect.height / 2 - tooltipSize.height / 2),
        vh - tooltipSize.height - 16,
      ),
      left: rect.left - tooltipSize.width - GAP,
    });
  }
  // Pick the first candidate that fits the viewport; otherwise the
  // first candidate (the renderer will clamp inside the box).
  for (const c of candidates) {
    if (
      c.top >= 8 &&
      c.left >= 8 &&
      c.top + tooltipSize.height <= vh - 8 &&
      c.left + tooltipSize.width <= vw - 8
    ) {
      return c;
    }
  }
  // Last-resort: centred bottom of viewport.
  return {
    placement: "center",
    top: Math.max(16, (vh - tooltipSize.height) / 2),
    left: Math.max(16, (vw - tooltipSize.width) / 2),
  };
}

const TOOLTIP_WIDTH = 320;
const TOOLTIP_HEIGHT = 220; // enough headroom for two-line title + 4-line body + footer

export function OnboardingTour({
  includeAchievements = true,
  onClose,
}: TourProps) {
  const { t } = useTranslations();

  const stops = useMemo(
    () => buildTourStops({ includeAchievements }),
    [includeAchievements],
  );
  const [state, setState] = useState(() => initTourState(stops));
  const [rect, setRect] = useState<SpotlightRect | null>(null);

  const stop = currentStop(state);

  // Re-measure on step change, viewport resize, and scroll. We intentionally
  // *don't* MutationObserver the whole document — the targets are stable in
  // the layout and re-measuring on rAF after scroll/resize is plenty.
  useEffect(() => {
    if (!stop) return;
    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        setRect(measureTarget(stop.targetId));
      });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [stop]);

  // Focus management — moves focus to the primary action when the
  // step changes so keyboard users can hit Enter to advance. The
  // tooltip ref + `previousFocus` carry the focus-trap contract: tab
  // cycles inside the tooltip, and on close the originally-focused
  // element (e.g. the Settings → Account "Restart" button) regains
  // focus.
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!stop) return;
    primaryRef.current?.focus();
  }, [stop]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    return () => {
      previousFocusRef.current?.focus?.();
    };
  }, []);

  // Keyboard shortcuts: Esc = skip, ArrowLeft / ArrowRight = nav,
  // Enter = next/done. We attach to window so the listener works
  // regardless of which element holds focus inside the tooltip.
  const handleSkip = useCallback(() => {
    setState((prev) => {
      const next = skipTour(prev);
      if (isTourFinished(next)) {
        // Defer the parent onClose so it doesn't run inside the
        // setState callback (which React calls during render in
        // strict-mode dev).
        queueMicrotask(() => onClose("skipped"));
      }
      return next;
    });
  }, [onClose]);

  const handleNext = useCallback(() => {
    setState((prev) => {
      const next = nextStep(prev);
      if (isTourFinished(next) && next.outcome === "completed") {
        queueMicrotask(() => onClose("completed"));
      }
      return next;
    });
  }, [onClose]);

  const handlePrev = useCallback(() => {
    setState((prev) => prevStep(prev));
  }, []);

  useEffect(() => {
    if (!stop) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        handleSkip();
      } else if (e.key === "Tab") {
        // Trap focus inside the tooltip so the user can't tab onto the
        // dimmed page underneath while the tour is active.
        const root = tooltipRef.current;
        if (!root) return;
        const focusables = Array.from(
          root.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
          ),
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey) {
          if (active === first || !root.contains(active)) {
            e.preventDefault();
            last.focus();
          }
        } else if (active === last) {
          e.preventDefault();
          first.focus();
        }
      } else if (e.key === "ArrowRight" || e.key === "Enter") {
        // Don't hijack Enter inside form inputs (none exist in the
        // tour itself but be defensive against future content).
        const target = e.target as HTMLElement | null;
        if (
          target &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.isContentEditable)
        ) {
          return;
        }
        e.preventDefault();
        handleNext();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        handlePrev();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stop, handleSkip, handleNext, handlePrev]);

  if (!stop) return null;

  const counter = stepCounter(state);
  const isLast = counter.current === counter.total;
  const tooltipPos = computeTooltipPosition(rect, stop.placement, {
    width: TOOLTIP_WIDTH,
    height: TOOLTIP_HEIGHT,
  });

  // Build a clip-path that punches out the spotlight rect from the
  // backdrop. `evenodd` fill rule + the outer rect winding the same
  // way means the inner rect carves a hole. If `rect` is null we
  // skip the cutout and render a solid backdrop.
  const clipPath = rect
    ? `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 ${rect.top}px, ${rect.left}px ${rect.top}px, ${rect.left}px ${rect.top + rect.height}px, ${rect.left + rect.width}px ${rect.top + rect.height}px, ${rect.left + rect.width}px ${rect.top}px, 0 ${rect.top}px)`
    : undefined;

  return (
    <div
      data-testid="onboarding-tour"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-tour-title"
      className="fixed inset-0 z-[200]"
    >
      {/* Backdrop with cutout. `pointer-events-auto` so a click on
          the dimmed area dismisses the tour (treated as Skip). The
          cutout itself uses `pointer-events-none` (transparent click
          pass-through) on the dimmed region — but to keep the click
          contract simple we use a single backdrop with the polygon
          clip and let any backdrop click count as Skip. The actual
          target underneath stays inert (the tour intentionally takes
          focus). prefers-reduced-motion users get an instant overlay
          (no opacity transition). */}
      <button
        type="button"
        aria-label={t("onboarding.tour.skip")}
        className="focus-visible:ring-primary absolute inset-0 cursor-default bg-black/70 transition-opacity duration-150 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none motion-reduce:transition-none"
        style={clipPath ? { clipPath, WebkitClipPath: clipPath } : undefined}
        onClick={handleSkip}
      />

      {/* Polite live region — announces the current step to screen readers. */}
      <p className="sr-only" aria-live="polite">
        {t("onboarding.tour.stepOf", {
          current: counter.current,
          total: counter.total,
        })}
        {": "}
        {t(stop.titleKey)}
      </p>

      {/* Tooltip card */}
      <div
        ref={tooltipRef}
        data-testid="onboarding-tour-tooltip"
        data-placement={tooltipPos.placement}
        className="bg-card border-border absolute max-h-[80vh] overflow-y-auto rounded-xl border p-5 shadow-2xl"
        style={{
          top: `${tooltipPos.top}px`,
          left: `${tooltipPos.left}px`,
          width: `${TOOLTIP_WIDTH}px`,
        }}
        // Stop click propagation so a click inside the card doesn't
        // bubble to the backdrop's Skip handler.
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3">
          <div>
            <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase tabular-nums">
              {t("onboarding.tour.stepOf", {
                current: counter.current,
                total: counter.total,
              })}
            </p>
            <h2
              id="onboarding-tour-title"
              className="mt-1 text-base font-semibold tracking-tight"
            >
              {t(stop.titleKey)}
            </h2>
          </div>
        </header>

        <p className="text-muted-foreground mt-3 text-sm leading-relaxed">
          {t(stop.bodyKey)}
        </p>

        <footer className="mt-5 flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleSkip}
            className="text-muted-foreground hover:text-foreground"
          >
            {t("onboarding.tour.skip")}
          </Button>
          <div className="flex items-center gap-2">
            {counter.current > 1 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handlePrev}
              >
                {t("onboarding.tour.back")}
              </Button>
            )}
            <Button
              ref={primaryRef}
              type="button"
              size="sm"
              onClick={handleNext}
              data-testid="onboarding-tour-primary"
            >
              {isLast ? t("onboarding.tour.done") : t("onboarding.tour.next")}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}
