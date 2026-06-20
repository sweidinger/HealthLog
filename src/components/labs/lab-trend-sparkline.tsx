"use client";

/**
 * v1.17.1 — minimal inline trend sparkline for an analyte's readings.
 *
 * A dependency-free 72×20 SVG polyline. This is DELIBERATELY a different
 * implementation from the detail page's Recharts `<LabBiomarkerChart>`: a
 * list row renders one tiny, axis-less, tooltip-less, interaction-less trend
 * per group (dozens on screen at once), where mounting a Recharts
 * `ResponsiveContainer` each would be heavy and visually noisy. The full
 * interactive chart — axes, reference band, range tabs, rich tooltip — lives
 * only on the single-biomarker detail surface. The same split (inline
 * polyline vs Recharts) is used by the doctor-report PDF. The two are not
 * drift; do not unify them.
 *
 * Rendered only when an analyte has ≥ 2 NUMERIC readings. Stroke uses the
 * neutral `currentColor` so it inherits the calm muted-foreground tone of its
 * row — no status colour, in keeping with the no-alarming-colour ethos.
 *
 * `values` are passed oldest → newest. v1.18.9 — qualitative readings carry no
 * number (`null`); they are filtered out here so a series with qualitative
 * entries plots only its numeric points and never a NaN.
 */
export function LabTrendSparkline({
  values: rawValues,
  width = 72,
  height = 20,
}: {
  values: (number | null)[];
  width?: number;
  height?: number;
}) {
  const values = rawValues.filter((v): v is number => v !== null);
  if (values.length < 2) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const stepX = width / (values.length - 1);
  const pad = 2;
  const usableH = height - pad * 2;

  const points = values
    .map((v, i) => {
      const x = i * stepX;
      // Invert Y so a higher value sits higher on screen.
      const y = pad + usableH - ((v - min) / span) * usableH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="text-muted-foreground/70 overflow-visible"
      aria-hidden
      role="presentation"
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.25}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
