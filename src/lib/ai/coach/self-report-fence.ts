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
 * v1.30.25 — the marker pair and the wrapping primitive now live in the
 * shared `data-fence` module alongside the SNAPSHOT and document-text
 * fences. Scrubbing is against EVERY known marker, not just this pair, so
 * self-report prose cannot forge the boundary of a neighbouring block.
 * Re-exported from here so the existing import sites keep working.
 */
export {
  SELF_REPORT_FENCE_START,
  SELF_REPORT_FENCE_END,
} from "@/lib/ai/coach/data-fence";

import {
  SELF_REPORT_FENCE_START,
  SELF_REPORT_FENCE_END,
  fenceBlock,
} from "@/lib/ai/coach/data-fence";

/**
 * Wrap the self-report text in the data-fence markers. Embedded marker
 * strings are removed from the content first — user text must never be
 * able to terminate the fence and smuggle trailing lines into
 * instruction position.
 */
export function fenceSelfReport(text: string): string {
  return fenceBlock(SELF_REPORT_FENCE_START, SELF_REPORT_FENCE_END, text);
}
