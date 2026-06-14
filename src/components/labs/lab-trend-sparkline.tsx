"use client";

/**
 * v1.17.1 — minimal inline trend sparkline for an analyte's readings.
 *
 * A dependency-free SVG polyline (the project defers Recharts for tiny
 * inline trends; this matches the doctor-report PDF's vector-polyline
 * approach). Rendered only when an analyte has ≥ 2 readings. Stroke uses
 * the neutral `currentColor` so it inherits the calm muted-foreground tone
 * of its row — no status colour, in keeping with the no-alarming-colour
 * ethos.
 *
 * `values` are passed oldest → newest.
 */
export function LabTrendSparkline({
  values,
  width = 72,
  height = 20,
}: {
  values: number[];
  width?: number;
  height?: number;
}) {
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
