# Phase A7 — Admin polish (v1.4.19)

Marathon: v1.4.19 Wave-A
Agent: A7 (parallel with A1-A6, A8)
Started: 2026-05-09T13:00+02:00
Finished: 2026-05-09T13:22+02:00
Branch: `agent/a7-admin-polish` (worktree at `/Users/marc/Projects/HealthLog-a7`)
Commits on `origin/main`:

- `088832a` — fix(admin): remove spurious scrollbar from feedback tab strip
- `dd8212e` — fix(admin): api-tokens table truncate-with-tooltip (no scrollbar 4th attempt)
- `7a70db6` — fix(admin): hide collapse button when page has only one section
- `6507646` — style(admin): reduce excessive vertical whitespace on Zielwerte page
- `90a109d` — i18n(admin): translate Zielwerte status labels (Low/On Target/Stable/Moderate to DE)

## What landed

### 1. Feedback tab strip mini-scrollbar — fixed
Marc's "mini Scroll-Button rechts" on the admin feedback inbox tabs
came from a CSS overflow-axis coupling: `tabsListVariants` set
`overflow-x: auto` without `overflow-y`, so the browser silently
flipped `overflow-y` to `auto` too. Combined with the fixed `h-9`
strip and badge children that ride 1-2 px taller than the strip on
some glyph stacks, a tiny vertical bar painted on the right edge of
short strips. Added `overflow-y-hidden` (with the matching
`overflow-y-visible` override for vertical-orientation tabs) and a
component test that locks both axes in.

### 2. /admin/api-tokens 4th-attempt scrollbar — fixed
Three previous fixes (column-hide v1.4.15, mobile card-list
v1.4.16, admin-shell mobile-strip `no-scrollbar` v1.4.18) cleared
the obvious culprits but Marc still saw a residual painted bar.
Production probe at Pixel-5 confirmed:

- The mobile token-name `<span>` carried `truncate` AND `break-all`
  on the same element. `truncate` sets `white-space: nowrap` which
  beats `word-break: break-all` per CSS spec — `break-all` was dead
  code AND misleading. Removed.
- The desktop table had no per-column upper bound; long token names
  could spill past the row on 768-1024 px viewports. Locked the
  layout with `table-fixed` + `<colgroup>` widths.
- Permission badges had no `max-w` cap. Added
  `max-w-full truncate` + native `title` attribute.
- Wrapped every potentially-long cell (token name, username,
  permission badge) in a small `<TruncatedCell>` helper that pairs
  visual truncation with a radix tooltip.

Added an e2e regression that walks every element inside the mobile
card-list and asserts `scrollWidth <= clientWidth + 1` for each.

### 3. /admin/api-tokens "Einklappen" button — removed
Inherited from the v1.4 shared-admin page where 13 sections lived
together. On the v1.5 dedicated `/admin/api-tokens` route the
toggle hides the only card on the page. Marc called it "sinnlos".
Dropped the `expanded` state + button. The shared `settings.collapse`
/ `settings.expand` keys stay in messages because
`<LoginOverviewSection>` still uses them.

### 4. Zielwerte page whitespace — tightened
Outer wrapper changed from `space-y-8` (32 px) to `space-y-6`
(24 px), matching the admin / settings rhythm.

### 5. Zielwerte status labels translated
Added two new i18n key blocks under `targets.*`:

- `targets.label.<TYPE>` (11 entries, EN + DE) — used by
  `<TargetCard>` to localise card titles. Server keeps emitting
  English labels so logs / external consumers don't churn.
- `targets.status.<key>` (41 entries, EN + DE) — every
  classification category from `lib/analytics/classifications.ts`,
  `pulse-targets.ts`, and the inline maps in `targets/route.ts`.
  A small `STATUS_CATEGORY_KEY` map on the page normalises the
  human-readable English category to its key.

Glucose targets keep their pre-resolved label path. Unmapped
categories fall through to the verbatim server string — the page
never blows up.

## Tests

- `src/components/ui/__tests__/tabs.test.tsx` (new) — locks `overflow-y-hidden` on tabs-list.
- `src/components/admin/__tests__/api-token-truncate.test.tsx` (new) — 4 cases on the truncate / tooltip / max-w pattern.
- `src/components/admin/__tests__/api-token-no-collapse.test.tsx` (new) — 3 cases (EN, DE, aria-expanded).
- `src/app/__tests__/targets-spacing.test.tsx` (new) — locks `space-y-6` on `/targets`.
- `src/app/__tests__/targets-i18n.test.tsx` (new) — 3 cases (EN, DE titles, DE status badges).
- `e2e/admin-api-tokens-mobile.spec.ts` — added the 4th-attempt regression.
- `src/lib/__tests__/i18n-locale-integrity.test.ts` — added 5 entries to `PLACEHOLDER_ALLOWLIST` for legitimate EN==DE technical terms (BMI, Normal, Optimal, Fitness).

## Verification

- `pnpm test`: 1658 / 1658 green
- `pnpm typecheck`: clean
- `pnpm lint`: 0 errors / 12 pre-existing warnings (baseline)

## Surfaces and constraints

Touched only the assigned A7 surfaces (feedback inbox via the
shared TabsList primitive, api-tokens section, targets page,
i18n messages). Did not touch `src/components/settings/*`,
`src/lib/insights/*`, `src/lib/ai/*`, `src/components/charts/*`,
or `src/components/insights/*`. No new dependencies. Pushed to
`origin/main` after rebase without `--no-verify` or `--no-gpg-sign`.
