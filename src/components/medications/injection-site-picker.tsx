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
 * Injection-site picker — anatomical front-of-body figure with 8
 * tappable sites.
 *
 * The body is a clean, gender-neutral medical line-art figure shipped as
 * a small transparent raster (`/injection-body-front.png`, ~8 KB). It is
 * painted THEME-AWARE without baking in a colour: the figure's alpha is
 * used as an SVG mask (`mask-type="alpha"`) over a `<rect>` filled with
 * `currentColor`, so the strokes take the picker's text colour and tint
 * correctly in light/dark and across the zinc/Dracula palettes. Keeping
 * the figure inside the SVG (rather than a CSS-masked sibling element)
 * means it shares the exact `viewBox` coordinate space as the dots, so
 * alignment is responsive by construction.
 *
 * `viewBox="0 0 100 200"` (aspect ≈0.5). The figure is drawn height-fit
 * and horizontally centred on that box; `SITE_COORDS` is expressed on the
 * same viewBox and measured to land each anchor on the figure's anatomy.
 * The recommended-next ring, the last-used marker and the selected fill
 * all read directly from those coordinates.
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

  // Stable, instance-unique id for the SVG mask so two pickers on one
  // page can't collide their <defs>.
  const uid = useId().replace(/[:]/g, "");
  const bodyMaskId = `inj-body-mask-${uid}`;

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
          {/* The body figure's alpha drives an SVG mask. `mask-type="alpha"`
              keys on the PNG's transparency (strokes opaque, surround
              transparent) rather than luminance, so a `<rect fill=
              currentColor>` painted through it renders the figure in the
              picker's text colour — theme-aware in light/dark and across
              the zinc/Dracula palettes with no baked-in tint. The image is
              height-fit + horizontally centred on the 100×200 box so it
              shares the dots' coordinate space exactly. */}
          <mask
            id={bodyMaskId}
            maskUnits="userSpaceOnUse"
            x="0"
            y="0"
            width="100"
            height="200"
            style={{ maskType: "alpha" }}
          >
            <image
              href="/injection-body-front.png"
              x="0"
              y="0"
              width="100"
              height="200"
              preserveAspectRatio="xMidYMid meet"
            />
          </mask>
        </defs>

        {/* Anatomical front-of-body figure — a clean, gender-neutral
            medical line-art body painted in `currentColor` through the
            alpha mask above. The figure is calibrated so the upper-arm
            anchors (x23/77 @ y78) sit on the arm mass clear of the torso,
            the abdomen quadrants (x43.5/56.5 @ y81/95) sit on the torso
            either side of the midline, and the thigh anchors (x40/60 @
            y140) sit on the centre of each thigh — the dots land on real
            anatomy. Rendered at a soft opacity so it reads as a calm
            backdrop the dots sit on rather than competing with them. */}
        <rect
          x="0"
          y="0"
          width="100"
          height="200"
          fill="currentColor"
          mask={`url(#${bodyMaskId})`}
        />

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
