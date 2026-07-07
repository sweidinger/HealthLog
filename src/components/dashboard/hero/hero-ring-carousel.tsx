"use client";

/**
 * Hero ring carousel — the mobile face of the dashboard-hero ring row.
 *
 * Below `md` the wellness rings no longer wrap into a multi-row grid
 * (which ate vertical space); instead a single ring shows centred and
 * the user swipes left/right through the set. The mechanism is a
 * dependency-free CSS scroll-snap track — a horizontal `overflow-x-auto`
 * flex whose slides are each full-width `snap-center`, so exactly one
 * ring is visible at a time and native touch/keyboard scrolling moves
 * between them. A row of dot indicators below the track shows the
 * position; the active dot rides `--primary`, inactive dots muted.
 *
 * At `md` and up the SAME track reverts, purely in CSS, to the inline
 * right-aligned ring row it always was: `md:overflow-x-visible`,
 * `md:snap-none`, `md:justify-end`, and slides collapse to their own
 * width (`md:w-auto`). Every ring is visible at once and the dot row is
 * hidden — the desktop layout is unchanged.
 *
 * a11y: the track is a focusable scroll region (native arrow-key
 * scrolling), each ring carries its own metric label + aria, the dots
 * are real buttons that scroll to their slide with an aria-current on
 * the active one, and the programmatic scroll honours
 * `prefers-reduced-motion` (jump, don't glide). The track scrolls inside
 * itself, so no phone width overflows the page.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "@/lib/i18n/context";
import { prefersReducedMotion } from "@/lib/charts/reduced-motion";
import type { ScoreRingId } from "@/lib/dashboard-layout";
import { cn } from "@/lib/utils";

export interface HeroRingSlide {
  /** Stable key + dot label anchor. */
  key: string;
  /** Selected-ring id when the slide is a `scoreRings` entry (carries the
   *  `data-ring` contract the tests + wellness vocabulary rely on); the
   *  health-score slide leaves it unset. */
  ringId?: ScoreRingId;
  /** The rendered `<ScoreRing>` node. */
  node: React.ReactNode;
  /** Optional detail destination — wraps the ring in a focusable link so a
   *  tap opens the metric's detail. A real anchor keeps tap-vs-drag native
   *  on the mobile carousel: a swipe scrolls the track, only a tap fires
   *  navigation. Omit to leave the ring non-interactive. */
  href?: string;
  /** aria-label for the ring link ("Open {metric} details"). */
  linkLabel?: string;
}

export function HeroRingCarousel({ slides }: { slides: HeroRingSlide[] }) {
  const { t } = useTranslations();
  const trackRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  // A single slide is not a carousel: no dots, no scroll affordance.
  const multi = slides.length > 1;

  // Track the active slide from the scroll offset. Each slide is exactly
  // the track's own width (full-width snap slide), so `scrollLeft /
  // clientWidth` rounds straight to the slide index — no Intersection
  // Observer bookkeeping needed. On desktop the track has no overflow, so
  // `scrollLeft` stays 0 and the (hidden) dots stay on the first.
  useEffect(() => {
    const track = trackRef.current;
    if (!track || !multi) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const w = track.clientWidth || 1;
        const idx = Math.round(track.scrollLeft / w);
        setActive(Math.min(slides.length - 1, Math.max(0, idx)));
      });
    };
    track.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      track.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [multi, slides.length]);

  const goTo = (index: number) => {
    const track = trackRef.current;
    if (!track) return;
    track.scrollTo({
      left: index * track.clientWidth,
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  };

  return (
    <div
      data-slot="dashboard-hero-rings"
      className="w-full md:w-auto md:shrink-0"
    >
      <div
        ref={trackRef}
        data-slot="dashboard-hero-ring-track"
        role="group"
        aria-label={t("dashboard.hero.ringCarousel.aria")}
        tabIndex={multi ? 0 : undefined}
        className={cn(
          // Mobile: one full-width ring per viewport, native swipe between
          // them; the scrollbar is hidden (the dots are the affordance).
          "no-scrollbar flex snap-x snap-mandatory overflow-x-auto rounded-lg",
          "motion-safe:scroll-smooth",
          "focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none",
          // Desktop: back to the inline right-aligned ring row, every ring
          // visible, no snapping — the pre-carousel layout unchanged.
          "md:snap-none md:justify-end md:gap-6 md:overflow-x-visible md:rounded-none",
        )}
      >
        {slides.map((slide) => (
          <div
            key={slide.key}
            data-carousel-slide=""
            {...(slide.ringId
              ? {
                  "data-slot": "dashboard-hero-ring",
                  "data-ring": slide.ringId,
                }
              : {})}
            className={cn(
              // Mobile: a full-width centred slide → exactly one ring shows.
              "flex w-full shrink-0 snap-center items-center justify-center",
              // Desktop: collapse to the ring's own width, inline in the row.
              "md:w-auto",
            )}
          >
            {slide.href ? (
              // A real anchor sized to the ring: a tap navigates, a
              // horizontal drag scrolls the track (native tap-vs-drag), and
              // it is keyboard-focusable with a rounded focus ring.
              <Link
                href={slide.href}
                aria-label={slide.linkLabel}
                data-slot="dashboard-hero-ring-link"
                className="focus-visible:ring-ring/50 rounded-full focus-visible:ring-2 focus-visible:outline-none"
              >
                {slide.node}
              </Link>
            ) : (
              slide.node
            )}
          </div>
        ))}
      </div>
      {multi ? (
        <div
          data-slot="dashboard-hero-ring-dots"
          className="mt-2 flex items-center justify-center gap-1 md:hidden"
        >
          {slides.map((slide, i) => {
            const isActive = i === active;
            return (
              <button
                key={slide.key}
                type="button"
                onClick={() => goTo(i)}
                data-slot="dashboard-hero-ring-dot"
                data-active={isActive ? "true" : undefined}
                aria-current={isActive ? "true" : undefined}
                aria-label={t("dashboard.hero.ringCarousel.dot", {
                  index: i + 1,
                  total: slides.length,
                })}
                className="focus-visible:ring-ring/50 flex items-center justify-center rounded-full p-1.5 focus-visible:ring-2 focus-visible:outline-none"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "block h-2 rounded-full transition-all",
                    isActive ? "bg-primary w-4" : "bg-muted-foreground/40 w-2",
                  )}
                />
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
