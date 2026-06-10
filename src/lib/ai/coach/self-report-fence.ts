/**
 * v1.16.1 — unambiguous data-fence markers for the user-authored
 * self-report (about-me / self-context questionnaire).
 *
 * The earlier fence was bare triple-quotes, which models also see around
 * code samples and which user text can trivially reproduce to "close"
 * the block early. The markers are unlikely literals, every frame that
 * embeds them states explicitly that the content between them is data
 * and never instructions, and `fenceSelfReport` scrubs embedded marker
 * strings so the content cannot forge a fence boundary.
 *
 * Dependency-free on purpose: both the Coach system prompt and the
 * briefing block builder (`about-me.ts`, which pulls `@/lib/db`) import
 * from here, so the fence never drags the Prisma client into a module
 * graph that only needs prompt text.
 */
export const SELF_REPORT_FENCE_START = "<<<SELF_REPORT_START>>>";
export const SELF_REPORT_FENCE_END = "<<<SELF_REPORT_END>>>";

/**
 * Wrap the self-report text in the data-fence markers. Embedded marker
 * strings are removed from the content first — user text must never be
 * able to terminate the fence and smuggle trailing lines into
 * instruction position.
 */
export function fenceSelfReport(text: string): string {
  const scrubbed = text
    .replaceAll(SELF_REPORT_FENCE_START, "")
    .replaceAll(SELF_REPORT_FENCE_END, "");
  return `${SELF_REPORT_FENCE_START}\n${scrubbed}\n${SELF_REPORT_FENCE_END}`;
}
