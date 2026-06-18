/**
 * `<SectionNavHeadingSpacer>` — invisible spacer that reserves exactly the
 * height of a section's heading block (h1 + subtitle) plus the `space-y-6`
 * gap that separates the heading from the first card.
 *
 * v1.18.6 (W9) — Marc's symmetry ask: the left settings / admin menu's first
 * item must line up with the TOP OF THE FIRST CARD, not with the page
 * heading. The page heading lives in the content column above the first card,
 * so the sidebar needs to start one heading-block lower. Replicating the
 * exact heading markup (same `text-2xl` h1 + `text-sm` subtitle) as a hidden,
 * `aria-hidden` block keeps the offset pixel-accurate across locales and
 * line-wrapping — a hard-coded `pt-[…]` would drift the moment a title or
 * subtitle wraps to a second line.
 *
 * It is only rendered on `md+` (the desktop sticky sidebar); the mobile chip
 * strip has no heading-to-align-with.
 */
export function SectionNavHeadingSpacer() {
  return (
    <div aria-hidden="true" className="invisible mb-6 select-none">
      <h1 className="text-2xl font-bold tracking-tight">&nbsp;</h1>
      <p className="text-muted-foreground text-sm">&nbsp;</p>
    </div>
  );
}
