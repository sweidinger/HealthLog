/**
 * v1.16.7 — single async boundary for the three mood mini-charts.
 *
 * The distribution / weekday / time-of-day charts were each deferred
 * through their own `next/dynamic` import, which produced three separate
 * chunk groups: the cards popped in one after another as each chunk
 * landed (incoherent reveal on the mood insights page), and each group
 * carried its own copy of the Recharts module graph. Funnelling all
 * three through this one barrel gives them a single shared chunk — they
 * arrive (and reveal) together, and Recharts is bundled once for the
 * trio.
 *
 * Consumers keep importing the chart types directly from the component
 * files (type-only imports are value-free and don't drag the chunk in).
 */
export { MoodDistributionChart } from "./mood-distribution-chart";
export { MoodWeekdayChart } from "./mood-weekday-chart";
export { MoodTimeOfDayChart } from "./mood-time-of-day-chart";
