"use client";

import { Fragment, type ReactNode } from "react";

import { cn } from "@/lib/utils";
import { stripChartTokens } from "@/lib/insights/chart-tokens";
import { learnUrl } from "@/lib/learn-links";
import { InlineLearnLink } from "@/components/ui/learn-more-link";

/**
 * v1.22 (W5) — shared paragraph renderer for every trusted-as-text AI
 * narrative surface (the Coach, the daily briefing, the per-metric /
 * score insight cards, the period narrative).
 *
 * The AI surfaces render their prose as plain React text children — there
 * is NO markdown library and NO `dangerouslySetInnerHTML` anywhere in the
 * tree (the project's XSS posture). Before this helper, three ad-hoc
 * approaches were in the tree (a single `<p>`, a `whitespace-pre-line`
 * `<p>`, and the Coach's word-span renderer), so a model that emitted real
 * paragraph breaks read as one run-on block.
 *
 * `ProseBlocks` settles that into ONE pure, XSS-safe splitter:
 *   - split a TRUSTED plain string on blank lines into real `<p>` blocks;
 *   - a single `\n` inside a paragraph becomes a `<br/>`;
 *   - recognised `/learn/<slug>` references (catalog-whitelisted, already
 *     post-filtered server-side) render as a real, safe `<a>` via
 *     `InlineLearnLink` — a closed-set linkifier, never model HTML.
 *
 * Everything is `String.prototype.split` + React children — no parser, no
 * markdown dependency, no injected markup. The chart-token strip
 * (`stripChartTokens`) runs PER LINE (not on the whole string): it
 * normalises intra-line whitespace, so running it on the full text would
 * collapse the `\n\n` paragraph breaks before they can be split on. Splitting
 * paragraphs first, then stripping each line, keeps the structure intact
 * while still ensuring a stray `metric:<TYPE>` token never surfaces.
 */

/** Default paragraph styling shared by every prose surface + the Coach
 *  streaming tail, so the streamed and settled renders line up exactly. */
export const PROSE_PARAGRAPH_CLASS =
  "leading-relaxed [&:not(:first-child)]:mt-3";

/**
 * Split a trusted-as-text string into real paragraphs on blank lines.
 * Whitespace-only fragments are dropped. Exported for the streaming
 * paragraph-aware renderer + unit tests.
 */
export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Catalog-whitelisted `/learn/<slug>` matcher. Mirrors the post-filter's
 * grammar (`learn-link-guard.ts`): the host is optional (relative or the
 * absolute `healthlog.dev/learn/<slug>` form), the slug is the lower-case
 * hyphenated path segment after `/learn/`. The capture is validated against
 * the published catalog (`learnUrl`) before an anchor renders — an unknown
 * slug stays plain text, so a drifted post-filter can never produce a
 * clickable invented link.
 */
const LEARN_URL_RE =
  /(?:https?:\/\/)?(?:[a-z0-9.-]*healthlog\.dev)?\/learn\/[a-z0-9-]+\/?/gi;

/**
 * Turn a trusted single line of text into React children, rendering any
 * catalog-known `/learn/<slug>` reference as a safe `InlineLearnLink` and
 * leaving everything else as plain text nodes. An unknown slug (which the
 * server post-filter should already have stripped) falls through as plain
 * text — fail-closed, never a fabricated anchor.
 */
function linkifyLearnLinks(line: string): ReactNode {
  if (!line.includes("/learn/")) return line;

  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  // `matchAll` over a global regex gives each match with its index so we
  // slice the surrounding text verbatim — no mutation of the source.
  for (const match of line.matchAll(LEARN_URL_RE)) {
    const matched = match[0];
    const start = match.index ?? 0;
    // The slug is the path segment after `/learn/`, minus a trailing slash.
    const slug = matched
      .slice(matched.indexOf("/learn/") + "/learn/".length)
      .replace(/\/$/, "")
      .toLowerCase();
    if (learnUrl(slug) == null) continue; // unknown slug → leave as plain text

    if (start > lastIndex) nodes.push(line.slice(lastIndex, start));
    nodes.push(
      <InlineLearnLink key={`learn-${key++}`} slug={slug}>
        {matched}
      </InlineLearnLink>,
    );
    lastIndex = start + matched.length;
  }
  if (nodes.length === 0) return line;
  if (lastIndex < line.length) nodes.push(line.slice(lastIndex));
  return <>{nodes}</>;
}

/**
 * Render one paragraph's inner text: each single `\n` becomes a `<br/>`, each
 * line is (optionally) chart-token-stripped, then run through the
 * catalog-whitelisted Learn linkifier. Stripping per LINE preserves the
 * `\n` breaks that a whole-string strip would collapse. Exported so the
 * Coach streaming renderer can settle completed paragraphs with the same
 * markup the non-streaming path produces.
 */
export function ParagraphText({
  text,
  strip = false,
  linkify = true,
}: {
  text: string;
  strip?: boolean;
  linkify?: boolean;
}) {
  const lines = text.split("\n");
  return (
    <>
      {lines.map((line, i) => {
        const cleaned = strip ? stripChartTokens(line) : line;
        return (
          <Fragment key={i}>
            {i > 0 && <br />}
            {linkify ? linkifyLearnLinks(cleaned) : cleaned}
          </Fragment>
        );
      })}
    </>
  );
}

export interface ProseBlocksProps {
  /** Trusted-as-text prose (model output already verified server-side). */
  text: string;
  /**
   * Strip stray `metric:<TYPE>` chart tokens first (defence-in-depth).
   * Defaults true for AI prose; pass false for already-cleaned input or
   * for plain user text where a literal `metric:` substring is meaningful.
   */
  strip?: boolean;
  /** Linkify catalog-known `/learn/<slug>` references. Default true. */
  linkify?: boolean;
  /** Per-paragraph class override (defaults to `PROSE_PARAGRAPH_CLASS`). */
  paragraphClassName?: string;
}

export function ProseBlocks({
  text,
  strip = true,
  linkify = true,
  paragraphClassName,
}: ProseBlocksProps) {
  // Split on blank lines FIRST (raw text), then strip per line inside
  // `ParagraphText` — a whole-string strip would collapse the breaks.
  // Drop a paragraph that is empty once its tokens are stripped (a rare
  // token-only line), so no hollow `<p>` renders.
  const paras = splitParagraphs(text).filter(
    (p) => !strip || stripChartTokens(p).length > 0,
  );
  return (
    <>
      {paras.map((p, i) => (
        <p key={i} className={cn(paragraphClassName ?? PROSE_PARAGRAPH_CLASS)}>
          <ParagraphText text={p} strip={strip} linkify={linkify} />
        </p>
      ))}
    </>
  );
}
