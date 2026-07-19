/**
 * Resolve a fact's provenance quote against the REAL extracted document text.
 *
 * Why this exists: the extraction prompt asks the model to echo "the exact
 * verbatim span of the document the fact came from" and the pipeline used to
 * store that echo as-is. A model can paraphrase it, normalise it, or invent it
 * outright, and the stored quote is then an anchor that points at nothing — or,
 * worse, at a span the document never contained, presented to a human reviewer
 * as if it were a verbatim transcription of their clinical record.
 *
 * The model's echo is therefore treated as a LOOKUP KEY, never as content. We
 * search the extracted text for it and store the span the DOCUMENT actually
 * carries. When the echo cannot be located, the fact is marked unanchored and
 * carries no quote at all: "we could not verify this against the source" is an
 * honest answer, an unverifiable quote is not.
 *
 * Two passes, cheapest first:
 *   1. exact substring — the common case, the model echoed the span verbatim;
 *   2. whitespace-collapsed + case-folded substring — covers OCR line wrapping,
 *      column merges, and case drift, which are reflow artefacts rather than
 *      paraphrase. The offset map walks the match back to the ORIGINAL text so
 *      the stored span keeps the document's own characters and spacing.
 *
 * A paraphrase fails both passes by construction, which is the point.
 */

/**
 * Minimum normalised length a quote must reach before we try to locate it. A
 * one- or two-character key matches somewhere in almost any document, so a
 * "match" that short would be noise dressed up as provenance.
 */
const MIN_ANCHORABLE_LENGTH = 3;

/** Longest span we store, mirroring the provenance column's own cap. */
const MAX_SPAN_LENGTH = 2000;

export interface AnchoredSource {
  /**
   * The verbatim span as it appears in the extracted text, or "" when the
   * quote could not be located (or there was no extracted text to search).
   */
  sourceText: string;
  /** True only when `sourceText` was read back out of the document text. */
  anchored: boolean;
  /** Character offset of the span in the extracted text; null when unanchored. */
  sourceOffset: number | null;
}

/** The unanchored result — no quote, no offset, no claim. */
const UNANCHORED: AnchoredSource = {
  sourceText: "",
  anchored: false,
  sourceOffset: null,
};

/**
 * Whitespace-collapsed, case-folded projection of `text`, plus a map from each
 * projected character back to its index in the original string. Folding is
 * skipped for any character whose lowercase form is not exactly one code unit,
 * so the map stays 1:1 and an offset can never drift.
 */
function project(text: string): { normalised: string; offsets: number[] } {
  const chars: string[] = [];
  const offsets: number[] = [];
  let pendingSpace = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      // Collapse a whitespace run to one space, and never lead with one.
      if (chars.length > 0) pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      chars.push(" ");
      offsets.push(i);
      pendingSpace = false;
    }
    const lower = ch.toLowerCase();
    chars.push(lower.length === 1 ? lower : ch);
    offsets.push(i);
  }
  return { normalised: chars.join(""), offsets };
}

/**
 * Locate `quote` inside `sourceText` and return the span the document actually
 * carries. `sourceText` is the text the extraction ran against — the OCR output
 * in text mode. Pass `undefined`/`""` for vision mode, where the model read the
 * rendered page directly and there is no extracted text to verify against: the
 * result is unanchored, because nothing in that flow can confirm the quote.
 */
export function anchorSourceText(
  quote: string,
  sourceText: string | undefined,
): AnchoredSource {
  if (!sourceText) return UNANCHORED;
  const trimmed = quote.trim();
  if (!trimmed) return UNANCHORED;

  // The length floor gates BOTH passes: a one-character key matches the exact
  // pass just as readily as the folded one, and a hit that short is noise
  // either way.
  const needle = project(trimmed);
  if (needle.normalised.length < MIN_ANCHORABLE_LENGTH) return UNANCHORED;

  // Pass 1 — the model echoed the span verbatim.
  const exact = sourceText.indexOf(trimmed);
  if (exact !== -1) {
    return {
      sourceText: sourceText.slice(exact, exact + trimmed.length),
      anchored: true,
      sourceOffset: exact,
    };
  }

  // Pass 2 — same span, reflowed or case-drifted by OCR.
  const haystack = project(sourceText);
  const hit = haystack.normalised.indexOf(needle.normalised);
  if (hit === -1) return UNANCHORED;

  const start = haystack.offsets[hit]!;
  const lastIndex = haystack.offsets[hit + needle.normalised.length - 1]!;
  return {
    sourceText: sourceText
      .slice(start, lastIndex + 1)
      .slice(0, MAX_SPAN_LENGTH),
    anchored: true,
    sourceOffset: start,
  };
}
