"use client";

import { useId, useState } from "react";

import { useTranslations } from "@/lib/i18n/context";
import {
  INJECTION_SITE_KEYS,
  SITE_COORDS,
  describeInjectionSite,
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
 * key. The body is traced to the proportions the iOS client calibrated
 * against (see `.planning/ios-coord/v0.12-…-injection-bodymap-coords.md`)
 * so dots land on the same anatomy on both platforms.
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
 * Touch: each visible dot is wrapped in an invisible hit-target circle.
 * The SVG renders at ≈320px tall over a 200-unit viewBox (≈1.6× scale),
 * so the r=14 transparent circle gives ≈45 CSS px — clearing the WCAG
 * 2.5.8 / 2.5.5 44px floor without the abdomen pair (Δx=13 units ≈21px)
 * colliding visually, since only the painted r=4.5 dot is opaque.
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

        {/* Anatomical front-of-body silhouette — one continuous outline
            traced to the iOS reference proportions (upright, arms slightly
            out, plain oval head). Filled with the soft wash + a hairline
            stroke so it reads as a calm medical illustration. */}
        <path
          d="M 50 4
             C 44.2 4 39.8 8.6 39.8 15
             C 39.8 19.6 41.4 23.4 44 25.6
             C 43.4 28.4 42 30.4 39.2 31.4
             C 35 32.9 30.4 34.2 27.4 36.6
             C 24.4 39 23 42.8 22.2 47.4
             C 21.2 53.2 20.2 60 18.2 67
             C 16.4 73.4 14 80.4 12.6 86.4
             C 11.8 89.8 12.4 92.2 14.2 92.8
             C 16 93.4 17.6 91.8 18.4 88.6
             C 19.8 83 21.8 76.6 23.6 71
             C 24.4 68.4 25.4 67.8 25.8 69
             C 26.2 70.2 26 74 25.6 79
             C 25.2 84.6 24.8 90.6 25.2 95.6
             C 25.6 100.4 26.8 104.4 28 107.8
             C 27.2 119 26.2 133 26.6 145
             C 27 156.6 28.6 170 30 182
             C 30.6 187.4 31.4 191.6 33 193.4
             C 34.4 195 37 195.2 39 194.6
             C 40.8 194 41.4 192.2 41.6 189.4
             C 42.2 181.4 43 169 44 158
             C 44.8 149.4 45.6 141.4 46.4 136
             C 47 131.8 48.2 129.6 50 129.6
             C 51.8 129.6 53 131.8 53.6 136
             C 54.4 141.4 55.2 149.4 56 158
             C 57 169 57.8 181.4 58.4 189.4
             C 58.6 192.2 59.2 194 61 194.6
             C 63 195.2 65.6 195 67 193.4
             C 68.6 191.6 69.4 187.4 70 182
             C 71.4 170 73 156.6 73.4 145
             C 73.8 133 72.8 119 72 107.8
             C 73.2 104.4 74.4 100.4 74.8 95.6
             C 75.2 90.6 74.8 84.6 74.4 79
             C 74 74 73.8 70.2 74.2 69
             C 74.6 67.8 75.6 68.4 76.4 71
             C 78.2 76.6 80.2 83 81.6 88.6
             C 82.4 91.8 84 93.4 85.8 92.8
             C 87.6 92.2 88.2 89.8 87.4 86.4
             C 86 80.4 83.6 73.4 81.8 67
             C 79.8 60 78.8 53.2 77.8 47.4
             C 77 42.8 75.6 39 72.6 36.6
             C 69.6 34.2 65 32.9 60.8 31.4
             C 58 30.4 56.6 28.4 56 25.6
             C 58.6 23.4 60.2 19.6 60.2 15
             C 60.2 8.6 55.8 4 50 4 Z"
          fill={`url(#${bodyFillId})`}
          stroke="currentColor"
          strokeWidth="0.9"
          strokeLinejoin="round"
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
          x1="29"
          y1="88"
          x2="71"
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
              {/* Last-used marker — a soft solid ring so the user can see
                  where they injected most recently at a glance, distinct
                  from the dashed recommendation ring. Suppressed on the
                  active selection (the filled dot already says "here"). */}
              {isLastUsed && !disabled && (
                <circle
                  cx={coord.x}
                  cy={coord.y}
                  r="7"
                  fill="none"
                  className="stroke-foreground/35"
                  strokeWidth="1"
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
              {/* Invisible hit-target for touch. r=14 on the 200-unit
                  viewBox rendered at ≈320px tall (≈1.6× scale) gives
                  ≈45 CSS px diameter — clearing the WCAG 2.5.8 / 2.5.5
                  44px floor. The abdomen quadrants sit Δx=13 / Δy=14
                  units apart; the transparent targets touch but the
                  pointer always resolves to the nearest centre. */}
              <circle
                cx={coord.x}
                cy={coord.y}
                r="14"
                fill="transparent"
                role="button"
                tabIndex={disabled ? -1 : 0}
                aria-pressed={isActive}
                aria-disabled={disabled}
                aria-label={siteLabel(site)}
                onClick={disabled ? undefined : () => onChange(site)}
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
