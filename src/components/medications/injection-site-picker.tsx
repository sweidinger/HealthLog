"use client";

import { useId, useRef, useState } from "react";

import { useTranslations } from "@/lib/i18n/context";
import {
  INJECTION_SITE_KEYS,
  SITE_COORDS,
  describeInjectionSite,
  nearestSiteAt,
  nextInjectionSite,
  type InjectionSiteKey,
} from "@/lib/medications/injection-sites";

/**
 * Injection-site picker — anatomical front-of-body silhouette with 8
 * tappable sites.
 *
 * The silhouette is an INLINE SVG so it inherits the app's theme tokens
 * (`currentColor` + CSS variables) and tints correctly in light/dark and
 * across the zinc/Dracula palettes with no raster asset and no luminance
 * key. The body is hand-authored to the proportions the iOS client
 * calibrated against (see `.planning/ios-coord/v0.12-…-injection-bodymap-coords.md`):
 * an oval head + short neck, sloped shoulders, a torso that tapers to the
 * waist and flares to the hips, arms held slightly out to mid-thigh with
 * simple hands, and separated legs ending in feet — so dots land on the
 * same anatomy on both platforms.
 *
 * `viewBox="0 0 100 200"` (aspect ≈0.5). `SITE_COORDS` is expressed on
 * the same viewBox; the recommended-next ring, the last-used marker and
 * the selected fill all read directly from those coordinates.
 *
 * Per the long-standing "nichts brickt" directive the picker is opt-in —
 * mounted from the GLP-1 dashboard tile and the optional log dialog.
 * Existing intake flows keep working without it (the row's
 * `injectionSite` stays NULL).
 *
 * Pointer routing: a single transparent overlay rectangle spans the
 * whole SVG and resolves every tap to the NEAREST site centre via
 * {@link nearestSiteAt} (the overlay projects the client point into
 * viewBox space through the live `getScreenCTM()`). This replaces the
 * old per-dot r=14 hit-circles, whose Ø=28u targets overlapped the
 * Δy=14u-apart abdomen quadrants by ~14u — SVG hit-testing resolves to
 * the topmost-painted element, not the nearest centre, so taps in that
 * band logged the WRONG quadrant. The overlay makes "nearest-centre
 * wins" actually true and keeps full-area (≥44px-equivalent) routing
 * since every pixel maps to its closest site; the visible dots stay
 * small (r=4.5). Keyboard / assistive-tech users get a per-site
 * focusable r=6 circle (non-overlapping at this spacing) carrying the
 * `role="button"` + `aria-label` + Space/Enter handler.
 */

interface InjectionSitePickerProps {
  /** Current selection, if any. */
  value: InjectionSiteKey | null;
  /** Recent rotation history (most recent first). Powers the
   *  "recommended next site" dashed-ring annotation and the subtle
   *  "last used" marker. */
  history?: ReadonlyArray<InjectionSiteKey>;
  /**
   * v1.8.5 — the effective allowed set (per-medication allowed sites
   * minus the user's global exclusion). When supplied, sites outside it
   * render disabled + non-interactive and the rotation recommendation is
   * constrained to this set. `undefined` keeps the legacy all-sites
   * picker (e.g. the wizard rotation preview, which has no medication
   * context yet).
   */
  allowed?: ReadonlyArray<InjectionSiteKey>;
  /** Called when the user picks a site. */
  onChange: (site: InjectionSiteKey) => void;
  /** Optional class for the outer wrapper. */
  className?: string;
}

export function InjectionSitePicker({
  value,
  history = [],
  allowed,
  onChange,
  className,
}: InjectionSitePickerProps) {
  const { t } = useTranslations();
  const recommended = nextInjectionSite(history, 4, allowed);
  const lastUsed = history[0] ?? null;
  const allowedSet = allowed ? new Set(allowed) : null;
  const isAllowed = (site: InjectionSiteKey) =>
    allowedSet === null || allowedSet.has(site);
  // Track which site currently holds keyboard focus so we can paint a
  // high-contrast focus halo on the filled dot itself — a transparent
  // hit-target stroke alone is effectively invisible on the muted body
  // map (WCAG 2.4.7).
  const [focusedSite, setFocusedSite] = useState<InjectionSiteKey | null>(null);

  // Stable, instance-unique ids for the SVG paint servers so two pickers
  // on one page can't collide their <defs>.
  const uid = useId().replace(/[:]/g, "");
  const bodyFillId = `inj-body-${uid}`;

  // The overlay maps a pointer event to viewBox space through the live
  // CTM, then resolves the nearest allowed site centre and selects it.
  const svgRef = useRef<SVGSVGElement>(null);
  const handleOverlayPick = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    const local = point.matrixTransform(ctm.inverse());
    const site = nearestSiteAt(local.x, local.y, allowed);
    if (site) onChange(site);
  };

  // Accessible name: fold the rotation recommendation into the label so a
  // screen-reader user gets the "recommended next site" cue that is
  // otherwise conveyed only by the dashed ring.
  const siteLabel = (site: InjectionSiteKey): string => {
    const name = t(describeInjectionSite(site));
    return site === recommended
      ? t("medications.injectionSiteRecommendedAriaLabel", { site: name })
      : name;
  };

  return (
    <div
      className={`flex flex-col items-center gap-3 ${className ?? ""}`}
      role="group"
      aria-label={t("medications.injectionSitePickerAriaLabel")}
    >
      <svg
        ref={svgRef}
        viewBox="0 0 100 200"
        className="text-foreground/45 h-[320px] w-auto max-w-full"
        role="img"
        aria-label={t("medications.injectionSiteBodyOutlineAriaLabel")}
      >
        <defs>
          {/* A whisper-soft vertical wash gives the flat silhouette a
              little depth without fighting the theme — both stops are the
              current text colour at low alpha, so it tints with the body. */}
          <linearGradient id={bodyFillId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="currentColor" stopOpacity="0.06" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0.10" />
          </linearGradient>
        </defs>

        {/* Anatomical front-of-body silhouette — traced to the iOS
            reference proportions: a plain oval head on a short neck,
            naturally sloped shoulders, a torso that narrows to the waist
            and flares to the hips, arms held slightly away from the body
            reaching to mid-thigh, and separated legs ending in feet. The
            figure is composed as two mirror halves about x=50 so it stays
            perfectly symmetric, with the upper-arm mass sitting under the
            calibrated arm anchors (≈x26/74 @ y72) and the thigh mass under
            the thigh anchors (≈x43/57 @ y140) — the dots land on real
            anatomy on both platforms. Filled with the soft wash + a
            hairline stroke so it reads as a calm medical illustration. */}
        <g
          fill={`url(#${bodyFillId})`}
          stroke="currentColor"
          strokeWidth="0.9"
          strokeLinejoin="round"
          strokeLinecap="round"
        >
          {/* Head + neck — a clean oval head with small ears, a short
              tapering neck blending into the trapezius line. */}
          <path
            d="M 50 4.5
               C 46 4.5 42.8 8 42.8 13
               C 42.8 16.8 44.2 20 46.4 22
               C 46.4 24.6 45.8 26.4 44.2 27.4
               C 45.8 28 47.8 28.4 50 28.4
               C 52.2 28.4 54.2 28 55.8 27.4
               C 54.2 26.4 53.6 24.6 53.6 22
               C 55.8 20 57.2 16.8 57.2 13
               C 57.2 8 54 4.5 50 4.5 Z"
          />
          {/* Ears */}
          <path d="M 42.9 14.4 C 41.6 13.8 40.8 15 41.2 16.4 C 41.5 17.5 42.4 18 43 17.6 Z" />
          <path d="M 57.1 14.4 C 58.4 13.8 59.2 15 58.8 16.4 C 58.5 17.5 57.6 18 57 17.6 Z" />
          {/* Torso + legs — one outline. From the neck the shoulders slope
              out to the top of the arms, dive into the armpit notch, run
              down the torso side (narrowing to the waist, flaring to the
              hips), split at the crotch into two legs ending in feet, and
              mirror back up the right side. The arms are drawn separately
              (below) so there is a clean underarm gap and the arm anchors
              sit on real arm mass, not on the torso edge. */}
          <path
            d="M 50 27
               C 47.6 27 45.6 27.4 43.6 28
               C 40.6 28.8 37.4 30 34.6 31.6
               C 36.4 33.4 37.6 36.2 38.2 39.6
               C 38.6 41.8 38 43.6 36.6 44.6
               C 38.2 47.6 39.4 51.8 39.8 56.4
               C 40.4 63 40.2 71 39.4 78
               C 38.8 83 38 86.8 38 90
               C 38 93.4 38.8 96.6 40 99
               C 39.2 102 38 105.4 37 108.8
               C 37 116 36.8 124 36.6 132
               C 36.4 144 36.8 157 37.8 169
               C 38.4 176.4 39 183 39.6 187.6
               C 40 190.6 40.4 192.6 41.4 193.4
               C 42.4 194.2 44 194 44.8 192.8
               C 45.4 191.8 45.8 189.8 46.2 186.8
               C 47 180 47.8 169.6 48.2 159
               C 48.6 149.4 48.8 139.8 49 132
               C 49.1 127.4 49.4 124 50 121.6
               C 50.6 124 50.9 127.4 51 132
               C 51.2 139.8 51.4 149.4 51.8 159
               C 52.2 169.6 53 180 53.8 186.8
               C 54.2 189.8 54.6 191.8 55.2 192.8
               C 56 194 57.6 194.2 58.6 193.4
               C 59.6 192.6 60 190.6 60.4 187.6
               C 61 183 61.6 176.4 62.2 169
               C 63.2 157 63.6 144 63.4 132
               C 63.2 124 62.6 116 61.8 108.8
               C 63 105.4 61.8 102 61 99
               C 62.2 96.6 62 93.4 62 90
               C 62 86.8 61.2 83 60.6 78
               C 59.8 71 59.6 63 60.2 56.4
               C 60.6 51.8 61.8 47.6 63.4 44.6
               C 62 43.6 61.4 41.8 61.8 39.6
               C 62.4 36.2 63.6 33.4 65.4 31.6
               C 62.6 30 59.4 28.8 56.4 28
               C 54.4 27.4 52.4 27 50 27 Z"
          />
          {/* Left arm — held slightly out, tapering from the shoulder to a
              rounded hand around hip height, with a clear underarm gap from
              the torso. The arm anchor (≈x26 @ y72) sits squarely on the
              upper-arm mass: at that height the arm spans ≈x21–31, so the
              dot is centred on the muscle. */}
          <path
            d="M 34.2 31.6
               C 32.2 32.6 30.8 34.4 29.8 37.2
               C 28.6 40.4 27.6 44.6 26.8 49.4
               C 26 54.2 25.4 59.6 24.8 64.8
               C 24.2 70 23.6 75.2 23 80
               C 22.4 84.8 21.8 89.2 21.4 92.8
               C 21 96 20.8 98.6 21 100.8
               C 21.2 102.6 20.8 104 20.4 105.2
               C 20 106.4 20 107.6 20.8 108.4
               C 21.6 109.2 22.8 109.2 23.8 108.6
               C 24.8 108 25.4 106.8 25.8 105.2
               C 26.2 103.6 26.6 101.4 27 98.8
               C 27.6 94.8 28.2 89.8 28.8 84.8
               C 29.4 79.6 30 74 30.6 68.8
               C 31.2 63.6 31.8 58.6 32.4 54
               C 33 49.4 33.6 45.2 34.4 41.8
               C 35 39 35.8 36.8 36.8 35.4
               C 37.6 34.2 37.2 32.6 35.8 31.8
               C 35.2 31.4 34.6 31.4 34.2 31.6 Z"
          />
          {/* Right arm — mirror of the left. */}
          <path
            d="M 65.8 31.6
               C 67.8 32.6 69.2 34.4 70.2 37.2
               C 71.4 40.4 72.4 44.6 73.2 49.4
               C 74 54.2 74.6 59.6 75.2 64.8
               C 75.8 70 76.4 75.2 77 80
               C 77.6 84.8 78.2 89.2 78.6 92.8
               C 79 96 79.2 98.6 79 100.8
               C 78.8 102.6 79.2 104 79.6 105.2
               C 80 106.4 80 107.6 79.2 108.4
               C 78.4 109.2 77.2 109.2 76.2 108.6
               C 75.2 108 74.6 106.8 74.2 105.2
               C 73.8 103.6 73.4 101.4 73 98.8
               C 72.4 94.8 71.8 89.8 71.2 84.8
               C 70.6 79.6 70 74 69.4 68.8
               C 68.8 63.6 68.2 58.6 67.6 54
               C 67 49.4 66.4 45.2 65.6 41.8
               C 65 39 64.2 36.8 63.2 35.4
               C 62.4 34.2 62.8 32.6 64.2 31.8
               C 64.8 31.4 65.4 31.4 65.8 31.6 Z"
          />
          {/* Feet — small forward-pointing shapes anchoring each leg so the
              figure reads as a full body rather than truncated calves. */}
          <path d="M 41.4 191.6 C 40 193.4 39.6 195.4 40.2 196.6 C 40.8 197.6 42.6 197.8 44.8 197.4 C 46.8 197 47.8 196.2 47.4 195 C 47 193.4 46.6 191.6 46.2 189.6 Z" />
          <path d="M 58.6 191.6 C 60 193.4 60.4 195.4 59.8 196.6 C 59.2 197.6 57.4 197.8 55.2 197.4 C 53.2 197 52.2 196.2 52.6 195 C 53 193.4 53.4 191.6 53.8 189.6 Z" />
        </g>

        {/* Centre + waist references — barely-there guides that help the
            eye read the abdomen quadrants. Kept low-alpha so they never
            compete with the dots. */}
        <line
          x1="50"
          y1="34"
          x2="50"
          y2="104"
          stroke="currentColor"
          strokeWidth="0.4"
          strokeOpacity="0.35"
        />
        <line
          x1="40"
          y1="88"
          x2="60"
          y2="88"
          stroke="currentColor"
          strokeWidth="0.4"
          strokeOpacity="0.35"
        />
        {/* Navel reference */}
        <circle cx="50" cy="88" r="0.9" fill="currentColor" fillOpacity="0.45" />

        {/* Click targets */}
        {INJECTION_SITE_KEYS.map((site) => {
          const coord = SITE_COORDS[site];
          const isActive = site === value;
          const isRecommended = site === recommended;
          const isLastUsed = site === lastUsed && !isActive;
          // v1.8.5 — a site outside the effective allowed set renders
          // disabled (dimmed, non-interactive) so the user cannot pick a
          // site the server would reject.
          const disabled = !isAllowed(site);
          const isFocused = site === focusedSite;
          return (
            <g key={site}>
              {/* Keyboard focus halo — a contrasting ring on the filled dot
                  that only shows while this site holds focus. Painted under
                  the recommendation ring and the dot so both stay legible. */}
              {isFocused && !disabled && (
                <circle
                  cx={coord.x}
                  cy={coord.y}
                  r="8"
                  fill="none"
                  className="stroke-ring"
                  strokeWidth="1.8"
                />
              )}
              {/* Last-used marker — a solid amber ring so the user can see
                  where they injected most recently at a glance, distinct
                  from the dashed primary recommendation ring. The amber tone
                  matches the dialog legend and reads in light + dark.
                  Suppressed on the active selection (the filled dot already
                  says "here"). */}
              {isLastUsed && !disabled && (
                <circle
                  cx={coord.x}
                  cy={coord.y}
                  r="7"
                  fill="none"
                  className="stroke-amber-500"
                  strokeWidth="1.2"
                />
              )}
              {isRecommended && !isActive && !disabled && (
                <circle
                  cx={coord.x}
                  cy={coord.y}
                  r="7"
                  fill="none"
                  className="stroke-primary"
                  strokeWidth="1.1"
                  strokeDasharray="2 2"
                />
              )}
              <circle
                cx={coord.x}
                cy={coord.y}
                r="4.5"
                className={
                  disabled
                    ? "fill-muted/30 stroke-foreground/20"
                    : isActive
                      ? "fill-primary stroke-primary-foreground"
                      : "fill-muted stroke-foreground/60 hover:fill-accent"
                }
                strokeWidth="1.1"
              />
              {/* Per-site focusable target for keyboard + assistive tech.
                  r=6 (Ø=12u) keeps it well inside the Δy=14u abdomen
                  spacing so adjacent targets never overlap — pointer
                  routing is owned by the single nearest-centre overlay
                  below, so this circle no longer needs to be a 44px tap
                  target. Keyboard activation (Space/Enter) stays here. */}
              <circle
                cx={coord.x}
                cy={coord.y}
                r="6"
                fill="transparent"
                role="button"
                tabIndex={disabled ? -1 : 0}
                aria-pressed={isActive}
                aria-disabled={disabled}
                aria-label={siteLabel(site)}
                onFocus={disabled ? undefined : () => setFocusedSite(site)}
                onBlur={
                  disabled
                    ? undefined
                    : () =>
                        setFocusedSite((current) =>
                          current === site ? null : current,
                        )
                }
                onKeyDown={
                  disabled
                    ? undefined
                    : (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onChange(site);
                        }
                      }
                }
                className={
                  disabled
                    ? "cursor-not-allowed focus:outline-none"
                    : "cursor-pointer focus:outline-none"
                }
              />
            </g>
          );
        })}

        {/* Single transparent pointer overlay — topmost in paint order so
            it catches every tap/click, projects it into viewBox space via
            the live CTM, and routes to the NEAREST site centre. This is
            the correctness fix for the overlapping abdomen quadrants: a
            tap in the former Δy=14u overlap band now deterministically
            picks the nearer quadrant rather than the last-painted dot.
            Full-area routing also means there are no sub-44px dead zones.
            `aria-hidden` keeps it out of the AT tree — the per-site
            focusable circles above own keyboard + screen-reader access. */}
        <rect
          x="0"
          y="0"
          width="100"
          height="200"
          fill="transparent"
          aria-hidden="true"
          className="cursor-pointer focus:outline-none"
          onClick={(e) => handleOverlayPick(e.clientX, e.clientY)}
        />
      </svg>

      <div className="text-center text-xs">
        {value ? (
          <p className="text-foreground">{t(describeInjectionSite(value))}</p>
        ) : (
          <p className="text-muted-foreground">
            {recommended &&
              t("medications.glp1RotationSuggested", {
                site: t(describeInjectionSite(recommended)),
              })}
          </p>
        )}
      </div>
    </div>
  );
}
