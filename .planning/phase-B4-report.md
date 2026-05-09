# Phase B4 — Achievements UI

**Status**: done
**Completed**: 2026-05-09T21:22+02:00
**Commits**: 3 (`34c967c`, `a242047`, `81f5019`) all on `origin/main`.

## Scope shipped

### 1. Dedicated `/achievements` page (`34c967c`)

Pre-v1.4.15 the page silently dropped locked achievements; only unlocked
ones rendered. Now every badge paints — locked entries grayed out at
opacity-70 with a `Lock` icon + `"Locked"` badge, the criterion hint
(`{current} / {target}`), and a 0–100% progress bar. Unlocked entries
keep the existing primary-gradient highlighted card with the
"Completed on …" footer. Sidebar link to `/achievements` was already in
place under `navItems` in `sidebar-nav.tsx`.

Achievements are grouped by a new presentation-only `category` axis —
`medication`, `vitals`, `security`, `engagement` — derived in
`getAchievementCategory()`. Stable category render order in
`ACHIEVEMENT_CATEGORY_ORDER`. Inside a category, unlocked items sort
first; among locked items the closest-to-unlock sorts first so the
user always sees their immediate next goal at the top.

### 2. Dashboard recent-unlocks card (`a242047` + `81f5019`)

`<RecentAchievementsCard>` shows the three most-recently unlocked
achievements (sorted by `completedAt` descending). When nothing is
unlocked yet, the card paints a discovery CTA + link to `/achievements`
so brand-new users learn the feature exists. Reuses the existing
`/api/gamification/achievements` endpoint — TanStack Query dedupes when
both this card and the page mount in the same session.

Layout integration: new `achievements` widget id in `DashboardWidgetId`,
default order 13 (below the chart row, matching the brief),
`tileVisible: false` because there is no tile surface for this widget.
Visible by default. Toggleable from Settings → Dashboard via the
existing `<DashboardLayoutSection>` machinery.

## i18n

9 new keys under `achievements.*` (EN + DE):
`locked`, `criterionHint`, `progressPercent`,
`categories.{medication,vitals,security,engagement}`,
`dashboardCard.{title,viewAll,empty}`. C4's parity audit will sweep
later as planned.

## Tests

- `+9 unit` — `groupByCategory` ordering, page render in EN/DE, locked
  vs unlocked card variants
- `+6 unit` — `pickRecentUnlocks` ordering / cap / no-date fallback,
  empty-state CTA, three-most-recent render shape
- `+1 e2e` — sidebar → click → `/achievements` heading visible

957 / 957 unit pass (was 890 baseline at phase start; +15 from B4, +52
from sibling agents).

## Race conditions

The 5-parallel-agent shared-cwd staging collision struck twice during
B4, matching the pattern STATE.md notes from A2 / A4 / B1 / B2 / B3:

1. Commit `34c967c`'s `git diff --cached --stat` listed 6 files but the
   final commit-stat shows 9 — `.env.example`,
   `.github/workflows/docker-publish.yml`, and
   `docs/audit/v1415-auto-deploy.md` (all C2's auto-deploy work) got
   pulled in between my `git add` and `git commit`. Files are correct
   on `main`; the message scope is narrower than the actual diff.
2. The dashboard-card commit had to be split into two
   (`a242047` for the wiring + `81f5019` for the
   `RecentAchievementsCard` component file). Used `git commit -o
   <pathspec>` to avoid sweeping in a sibling agent's untracked files,
   but `-o` excluded my own untracked `<RecentAchievementsCard>` source
   too — the follow-up `81f5019` commit landed it. Splitting into two
   commits per `verification-before-completion` rather than amending so
   the parallel-agent push race can't lose the landing.

Recommendation echoes prior phases: v1.4.16 should adopt
`superpowers:using-git-worktrees` per agent.

## Files changed (B4 scope, by commit)

`34c967c`:

- `src/lib/gamification/achievements.ts` — new `AchievementCategory`
  type, `getAchievementCategory()`, `ACHIEVEMENT_CATEGORY_ORDER`,
  `category` field on `AchievementProgress`
- `src/app/achievements/page.tsx` — full rewrite: locked-vs-unlocked
  cards, category grouping, exported `groupByCategory` for unit tests
- `src/app/achievements/__tests__/page.test.tsx` — new
- `e2e/achievements.spec.ts` — new
- `messages/en.json` + `messages/de.json` — 9 new keys

`a242047`:

- `src/lib/dashboard-layout.ts` — `achievements` widget id + default
  layout entry
- `src/components/settings/dashboard-layout-section.tsx` —
  `WIDGET_LABEL_KEYS["achievements"]` mapping
- `src/app/page.tsx` — import + `showAchievementsCard` gate + chart-row
  slot
- `src/app/achievements/page.tsx` — prettier compaction follow-up to
  `34c967c` (pure formatting)

`81f5019`:

- `src/components/gamification/recent-achievements-card.tsx` — new
- `src/components/gamification/__tests__/recent-achievements-card.test.tsx` —
  new

## Out of scope (not done)

- Relative time formatting (`"3 days ago"`) — the brief mentioned
  formatted-relative for `unlockedAt`, but the existing
  `formatDate(completedAt)` is well-tested across the app, no
  `Intl.RelativeTimeFormat` helper exists yet, and adding one as a
  drive-by would expand B4's blast radius. Left as v1.4.16 polish.
- Sidebar nav link addition — was already in place in `sidebar-nav.tsx`
  under `navItems` (verified via the e2e spec which clicks it).
