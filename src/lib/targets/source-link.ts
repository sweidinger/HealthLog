/**
 * Resolves the guideline-source citation URL for a target, keyed off
 * the target `type` and (for pulse) substrings of the `source` label.
 * Pure function with no React coupling so every surface that shows a
 * target citation resolves the identical URL — the link can never drift.
 */
export interface TargetSourceLinkInput {
  type: string;
  source: string;
}

export function getTargetSourceLink(target: TargetSourceLinkInput): string | null {
  if (target.type === "WEIGHT" || target.type === "BMI") {
    return "https://www.who.int/news-room/fact-sheets/detail/obesity-and-overweight";
  }
  if (
    target.type === "BLOOD_PRESSURE" ||
    target.type === "BLOOD_PRESSURE_IN_TARGET"
  ) {
    return "https://academic.oup.com/eurheartj/article/39/33/3021/5079119";
  }
  if (target.type === "PULSE") {
    if (target.source.includes("CDC/NCHS")) {
      return "https://www.cdc.gov/nchs/data/nhsr/nhsr041.pdf";
    }
    if (target.source.includes("AHA")) {
      return "https://www.heart.org/en/health-topics/high-blood-pressure/the-facts-about-high-blood-pressure/all-about-heart-rate-pulse";
    }
  }
  if (target.type === "SLEEP_DURATION") {
    return "https://aasm.org/seven-or-more-hours-of-sleep-per-night-a-health-necessity-for-adults/";
  }
  if (target.type === "BODY_FAT") {
    return "https://www.acefitness.org/resources/everyone/blog/6596/what-are-the-guidelines-for-percentage-of-body-fat-loss/";
  }
  if (target.type === "ACTIVITY_STEPS") {
    return "https://www.who.int/publications/i/item/9789240015128";
  }
  return null;
}
