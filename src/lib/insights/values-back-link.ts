/**
 * v1.10.2 — resolve the back-link target for `/insights/values/[type]`.
 *
 * The "show all readings" link (built by `<SubPageShell>`) carries the
 * originating metric page as a `from` query param so the values sub-page can
 * return the user to where they drilled in from (e.g. `weight → show all
 * values → back to weight`) rather than always to the Insights overview.
 *
 * The param is sanitised to an internal `/insights/<slug>` path — a single
 * leading slash, no protocol / host, no protocol-relative `//` — so a crafted
 * `?from=` value can never become an off-site or protocol-relative navigation
 * target. Anything that fails the check falls back to the Insights overview.
 */
export const INSIGHTS_OVERVIEW = "/insights";

export function resolveValuesBackHref(from: string | null | undefined): string {
  if (
    from &&
    from.startsWith("/insights/") &&
    !from.startsWith("/insights//")
  ) {
    return from;
  }
  return INSIGHTS_OVERVIEW;
}
