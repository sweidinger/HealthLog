/**
 * Shared scroll-floor for the two-column sub-shells (Settings, Admin).
 *
 * Scroll height is shell-owned (over-scroll class, #154 lineage): only
 * `AuthShell` owns the scroll container's height and bottom padding — the
 * `<main>` clears the mobile bottom-nav and its wrapper clears the Coach FAB.
 * A sub-shell must NEVER re-declare a bottom gutter (`pb-*`) or a viewport
 * reserve (`min-h-[calc(100dvh-…)]`) on its own content column: a nested
 * reserve stacks on the shell budget and scrolls past the last card.
 *
 * The one sanctioned reserve is this loading-jump floor, applied to the
 * sub-shell GRID (not to a column): it keeps the page height stable while a
 * freshly-navigated section is still fetching, without over-shooting the
 * viewport on a short section. The `<main>`/cards column is the grid's `1fr`
 * row, so it stretches to fill exactly and never over-scrolls.
 *
 * Both sub-shells derive the floor from THIS single constant so the two can
 * never drift — Admin previously carried a stale, all-breakpoint
 * `min-h-[calc(100dvh-12rem)]` column reserve that this de-duplication retires.
 *
 * Budget: top bar 4rem + the AuthShell wrapper's `pt-6` (1.5rem) + `pb-20`
 * (5rem) = 10.5rem. Retune here — and only here — if those shell paddings
 * change. (Latent follow-up: this constant assumes zero banners above `<main>`;
 * a locale/offline/demo banner or an iOS PWA safe-area inset makes it
 * over-reserve. A fully self-accounting `min-h-full` chain would need the
 * AuthShell content wrapper to pass a definite height through, which is out of
 * scope for the shell-only over-scroll fix.)
 */
export const SUB_SHELL_GRID_FLOOR = "md:min-h-[calc(100dvh-10.5rem)]";
