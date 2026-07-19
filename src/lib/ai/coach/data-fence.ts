/**
 * v1.30.25 — the shared data/instruction fence for every prompt block that
 * carries user-controlled or document-sourced free text.
 *
 * Two blocks reach the Coach prompt with content the server did not author:
 *  - the self-report (about-me questionnaire) — the user's own prose, and
 *  - the SNAPSHOT — a JSON document whose leaves include lab analyte names,
 *    medication labels, illness labels, plan/reminder/fact text and workout
 *    sport names. Some of those strings did not originate with the user at
 *    all: a lab analyte name is transcribed by a model out of an UPLOADED
 *    PDF, so a hostile document can choose it.
 *
 * Escaping every leaf field separately does not scale (the snapshot is
 * assembled from a dozen builders and grows), and it cannot express the one
 * thing that actually matters: that everything inside the block is DATA and
 * never an instruction. A fence can. Each block is wrapped in unlikely
 * literal markers, the frame around it states the data/instruction contract
 * explicitly, and the content is scrubbed of EVERY known marker first — so
 * text inside one fence can neither close its own fence nor forge another
 * block's boundary and smuggle trailing lines into instruction position.
 *
 * Dependency-free on purpose: the Coach system prompt, the briefing block
 * builder and the document-extraction prompt all import from here, and the
 * fence must never drag the Prisma client into a module graph that only
 * needs prompt text.
 */

/** Fence around the user-authored self-report (about-me questionnaire). */
export const SELF_REPORT_FENCE_START = "<<<SELF_REPORT_START>>>";
export const SELF_REPORT_FENCE_END = "<<<SELF_REPORT_END>>>";

/** Fence around the Coach SNAPSHOT (server-computed figures + free-text leaves). */
export const HEALTH_DATA_FENCE_START = "<<<HEALTH_DATA_START>>>";
export const HEALTH_DATA_FENCE_END = "<<<HEALTH_DATA_END>>>";

/** Fence around OCR'd document text handed to the extraction model. */
export const DOCUMENT_TEXT_FENCE_START = "<<<DOCUMENT_TEXT_START>>>";
export const DOCUMENT_TEXT_FENCE_END = "<<<DOCUMENT_TEXT_END>>>";

/**
 * Every marker literal the codebase uses as a data/instruction boundary.
 * Content is scrubbed against the WHOLE set — not just its own pair — so a
 * hostile lab analyte name inside the SNAPSHOT cannot emit
 * `<<<SELF_REPORT_END>>>` to escape a neighbouring block.
 */
export const ALL_FENCE_MARKERS: readonly string[] = [
  SELF_REPORT_FENCE_START,
  SELF_REPORT_FENCE_END,
  HEALTH_DATA_FENCE_START,
  HEALTH_DATA_FENCE_END,
  DOCUMENT_TEXT_FENCE_START,
  DOCUMENT_TEXT_FENCE_END,
];

/** Strip every known fence marker out of `text`. */
export function scrubFenceMarkers(text: string): string {
  let out = text;
  for (const marker of ALL_FENCE_MARKERS) {
    out = out.replaceAll(marker, "");
  }
  return out;
}

/**
 * Wrap `text` in the given marker pair after scrubbing every known marker
 * out of the content. The caller supplies the surrounding frame prose that
 * states the data/instruction contract.
 */
export function fenceBlock(start: string, end: string, text: string): string {
  return `${start}\n${scrubFenceMarkers(text)}\n${end}`;
}

/**
 * Fence the Coach SNAPSHOT payload. The snapshot is JSON, but the fence is
 * applied to the serialised string: a free-text leaf that contains a marker
 * would otherwise survive `JSON.stringify` verbatim.
 */
export function fenceHealthData(snapshotJson: string): string {
  return fenceBlock(
    HEALTH_DATA_FENCE_START,
    HEALTH_DATA_FENCE_END,
    snapshotJson,
  );
}

/** Fence OCR'd document text before it enters the extraction prompt. */
export function fenceDocumentText(text: string): string {
  return fenceBlock(DOCUMENT_TEXT_FENCE_START, DOCUMENT_TEXT_FENCE_END, text);
}
