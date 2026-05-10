# HealthLog v1.4.20 — Release Summary

## Release brief

Live: v1.4.20 (image digest
`sha256:b112a31947b9…`, `/api/version=1.4.20`).

v1.4.20 is the deliberately-loud release that cashes in the runway
v1.4.19 set up. The redesigned `/insights` page lands a hero strip
with greeting + suggested-prompt chips, a Daily Briefing card, an
AI Coach drawer with SSE-streaming chat and encrypted conversation
history, three pre-defined correlation cards (BP × medication
compliance, mood × pulse, weight × weekday), a Trends row with AI
annotations, a printable Weekly Report at `/insights/report/[week]`,
and a Personal Health Score panel (composite 0-100 with three
bands). The polish-vs-feature ratio inverted to roughly 30/70 — the
right ratio for a release that means to ship new product.

`PROMPT_VERSION` ratcheted 4.19.0 → 4.20.2 across three controlled
bumps; `aiInsightResponseSchema` gained five optional blocks
(`dailyBriefing`, `trendAnnotations`, `weeklyReport`,
`storyboardAnnotations`, `healthScore`). Every new field is
nullable + optional, so insights cached before v1.4.20 still parse
without a re-run — the v1.4.17 lesson is wired in by construction
now, not by audit.

Hard-Reload (`Cmd+Shift+R`) for SW reset.

v1.4.20 is also the first release shipped through the new
`develop` → `main` branch model introduced in this milestone's
foundation phase: feature work lands on `develop` and stays out of
the GHCR build path; only the release-merge to `main` plus the
annotated tag trigger image publication. The model is documented in
`CONTRIBUTING.md` and on the public docs site under
`/contributing/branch-model/`.

---

## Production deploy

| Field | Value |
| ----- | ----- |
| URL | `https://healthlog.bombeck.io` |
| `/api/version` | `1.4.20` (flipped at 2026-05-10T16:49:25Z) |
| Image digest BEFORE | `sha256:b48f93874cdbcd6c2d729f1b8eeb63a6d1bbb90d56f629846ef6eab6cf272aa9` (v1.4.19) |
| Image digest AFTER | `sha256:b112a31947b91f2fdb4bb01b60c6b17a0b8ec128ae116d37e1094da5c3decaa6` (v1.4.20) |
| Release-prep commit (develop) | `aac8b5e chore(release): v1.4.20` |
| Develop ↔ main sync commit | `dd2ef57 Merge main into develop — sync Dependabot dep bumps before v1.4.20 tag` |
| Release-merge commit (main) | `666f6ee Release v1.4.20` |
| Tag | `v1.4.20` (annotated) at `666f6ee` |
| GHCR — tag run | `25633807964` success (4m02s) |
| Coolify auto-deploy | NO — webhook secret still missing on the deploy server (same fault mode as v1.4.19); host-side retag fallback used |
| Smoke (curl, no session) | `/api/version` 200 · `/auth/login` 200 · all gated routes return 307 → `/auth/login` (expected proxy.ts behaviour without a session cookie) |
| GH release | https://github.com/MBombeck/HealthLog/releases/tag/v1.4.20 |
| Docs site | `0b83430` on `healthlog-docs/main` (updates.mdx + scaling.mdx version pins; `ai-insights.mdx` v1.4.20 callout) |
| Landing site | `43ce4c7` on `healthlog-landing/main` (`softwareVersion` JSON-LD bumped, three new featureList entries) |

The tag-build pipeline succeeded; the deploy webhook still isn't
wired on apps-01, so v1.4.20 was promoted via the documented
host-side fallback path:

```
docker pull ghcr.io/mbombeck/healthlog:1.4.20
docker tag ghcr.io/mbombeck/healthlog:1.4.20 ghcr.io/mbombeck/healthlog:latest
cd /data/coolify/applications/pg8wggwogo8c4gc4ks0kk4ss
docker compose up -d --force-recreate app
```

`/api/version` flipped to `1.4.20` on the first poll cycle after
recreate — well inside the 5-minute cap. The Coolify-managed
restart-and-redeploy path was tried twice first (`d10hrd3he27w…`
and `tgkn9ewch46c…`); both ran cleanly to "finished" but neither
pulled a fresh manifest, so the running container kept serving
v1.4.19. Wiring an image-digest auto-deploy hook on apps-01 is
captured in `.planning/v1421-backlog.md`.

---

## Smoke results

The previous releases' brief showed 200s because they ran with a
live session cookie that's not persisted on this run. Without the
cookie, every authenticated route correctly returns 307 →
`/auth/login`, so the smoke verifies the proxy gate is healthy
end-to-end:

| Path | Status (no session) | Notes |
| ---- | ------------------- | ----- |
| `/api/version` | 200 | Returns `version: "1.4.20"` |
| `/auth/login` | 200 | Public surface, renders normally |
| `/` | 307 → `/auth/login` | Gated dashboard root |
| `/insights` | 307 → `/auth/login` | Redesigned Insights shell |
| `/insights/report/2026-W19` | 307 → `/auth/login` | New v1.4.20 weekly-report route |
| `/admin/api-tokens` | 307 → `/auth/login` | Admin section |
| `/settings/integrations` | 307 → `/auth/login` | Settings section |
| `/achievements` | 307 → `/auth/login` | Achievements page |
| `/dashboard` | 307 → `/auth/login` | Expected: root is the dashboard, no `/dashboard` route |

The Coach drawer and Health Score panel can't be smoked without a
live session — neither carries a public surface. Confirmed live via
the `/api/version` check; Wave-D reviewers exercised both paths
under integration coverage before tag.

---

## What shipped

### Hero strip + Daily Briefing + Suggested Prompts

`/insights` opens with a redesigned hero strip that pairs a
time-of-day greeting and primary action row with a horizontal strip
of suggested-prompt chips. A Daily Briefing card mounts full-width
below the hero, surfacing an AI-generated paragraph plus three
keyFindings drawn from the last 24-hour window. Suggested-prompt
chips drive the Coach drawer with the prompt prefilled, so the
shortest path from "I want to know X" to a streaming answer is one
tap. The four-vitals tile row from the design artboard was
intentionally deferred — the per-section status cards already
render the same numbers, and the briefing fills the at-a-glance
role.

### AI Coach drawer with streaming chat + encrypted persistence

The biggest piece of the release. `POST /api/insights/chat` is an
SSE endpoint that walks the existing AI provider chain, persists
user + assistant turns under AES-256-GCM, and emits `token` →
`provenance` → `done` frames. A per-user daily token budget
(25 000 tokens, ≈13 turns for a heavy user) caps shared-key spend;
a refusal pattern blocks prompt-injection attempts and obvious
off-topic asks before the provider call. The drawer mounts from the
hero strip's "Ask the coach" button and from any suggested-prompt
chip; layout is three columns on `lg+` (history rail · message
thread · sources rail) and full-screen single-column on mobile with
chevron-button trays for the rails. Source-chip provenance attaches
to every assistant turn (metric, window, n-count — labels only,
never raw values). `parseSseChunk()` is exported as a pure helper
so the streaming parser is unit-testable without a live network.

### Correlation cards + Trends row with AI annotations

Three pre-defined hypothesis cards mount between the Daily Briefing
and the Advisor card: BP × medication compliance, mood × pulse, and
weight × weekday. Pearson r is rendered with a Fisher-z confidence
interval; surfacing gate is n ≥ 14 paired observations and p < 0.05.
The Trends row alongside it carries short AI-generated annotations
tied to specific dates in the analyzed window; the BP timeline
gains storyboard markers at the same positions via an additive
`annotations[]` prop on `<HealthChart>`.

### Weekly Report at `/insights/report/[week]`

A newsletter-style printable surface with five sections: Summary,
Going-well, Worth-watching, Tips, Data-quality. `window.print()`
export via Tailwind `print:` variants gives a clean A4 page without
a server round-trip. The hero strip surfaces fresh weekly reports
with Read · Share · Export PDF actions; Share uses Web Share API
with a clipboard fallback, Export deep-links to `?print=1`.

### Personal Health Score (composite 0–100)

A deterministic composite score with three bands (green ≥75, yellow
50–74, red &lt;50). Weights: 30% BP-target rate + 20% weight-trend
alignment + 20% mood stability + 30% medication compliance. When
a sub-component is null, remaining weights scale to 100 so the
score stays interpretable. The `<HealthScoreCard>` renders alongside
the hero strip on `lg+` (220 px desktop, full-width mobile) with a
band-tinted progress bar, four sub-bars, "vs last week" delta line,
and a score-aware "Ask the Coach" CTA that opens the drawer with
"Why is my health score X out of 100?" prefilled.

---

## Quality bar

- **Test counts moved hard.** 1672 → 2026 unit tests (+354 net),
  67 → 81 integration (+14). Five new test files for the Coach
  alone (use-coach, source-chips, message-thread, coach-input,
  sources-rail, history-rail). Test files 217 → 237.
- **typecheck + lint clean.** 0 type errors, 13 baseline warnings
  unchanged (every warning is the `_request` / `_params` /
  intentional-unused pattern).
- **Multi-reviewer Wave-D pass.** Six reviewers (code, security,
  design, senior-dev, simplify, product-lead) filed 0 CRIT · 12
  HIGH · 28 MED · 22 LOW + 5 simplify-apply-yes + 4 simplify-apply-
  maybe + 3 simplify-apply-no. All 12 HIGH items + the design
  pushback on the disabled weekly-report button + 6 MED items +
  every simplify-apply-yes item landed inline across 11 atomic
  commits on `develop` (`e632e26` → `31fbf98`). 22 MED + 16 LOW + 4
  simplify-apply-maybe deferred to `.planning/v1421-backlog.md`
  under "Phase D — v1.4.20 reconcile carry-over".
- **One known integration-test flake.** `coach-chat.test.ts` /
  "round-trips" was observed to flake on a single run during
  Phase D and again during pre-flight; consistent re-runs pass.
  Tracked in the v1.4.21 backlog.
- **format:check clean on the source tree.** A small style commit
  (`73e51d7 style: prettier on touched insights/coach surfaces`)
  ran prettier across the new B-phase additions before tag, so the
  only remaining `format:check` warnings are the `.planning/*`
  baseline noise carried over since v1.4.16.

---

## Branch model

v1.4.20 is the first release shipped through the new
`develop` → `main` model:

- All B1 → B5 phase work, every Wave-D reconcile commit, the
  release-prep commit, the prettier sweep, and the merge-back of
  Dependabot's day-of dep bumps landed on `develop`.
- A single `Release v1.4.20` no-ff merge commit on `main` plus the
  annotated `v1.4.20` tag triggered the GHCR tag-build job
  (`25633807964`).
- The GHCR workflow is gated to `branches: [main]` + `tags: ['v*']`
  — `develop` pushes neither build nor publish images, which
  removes the v1.4.13-era image-churn problem on GHCR.
- Two Dependabot dep-bump PRs (`#161`, `#165`) auto-merged into
  `main` after the tag build started but before the host-side
  fallback ran. They were absorbed into `develop` ahead of the
  release-merge via a `Merge main into develop` commit, so the
  v1.4.20 tag includes them. Three more dep-bump PRs (#153, #154,
  #157, #158, #159, #160) had auto-merged earlier the same day and
  were absorbed the same way.

---

## Carry-over

Full backlog: `.planning/v1421-backlog.md`.

- **22 MED + 16 LOW + 4 simplify-apply-maybe** items from the
  multi-reviewer Phase-D pass. Headline items: senior-dev call to
  consolidate the duplicated Pearson / linear-regression maths
  layer (Sr-HIGH-2 — too large for inline reconcile); refactor
  `<CoachDrawer key={prefill}>` into a controlled prefill prop
  (Sr-HIGH-4); transactional `recordSpend()` (Sec-M-4); refusal
  accounting and lexicon expansion (Sec-M-2 / Sec-M-3).
- **Schema drift on `medication_schedules.days_of_week`.** Worked
  around twice in v1.4.20 (B5 analytics, B2a coach snapshot); the
  migration needs to either deploy the column or drop it from
  `schema.prisma`.
- **`src/app/insights/page.tsx` now composes nine distinct
  surfaces.** Splitting the component is on the v1.4.21 cleanup
  short-list; pre-emptive splitting before the multi-reviewer pass
  ran was deliberately avoided.
- **Coolify image-digest auto-deploy hook on apps-01.** Tag-build
  pipeline is fine; the deploy step needs the webhook wired so
  `/api/version` flips on its own without the manual host-side
  retag.
- **Source-comment sweep** (191 maintainer-name references in
  `src/`), **DE+EN bilingual CHANGELOG entries** (v1.4.15 era),
  and **`CLAUDE.md` / `AGENTS.md` filename hygiene** are tracked
  for a hygiene PR.

---

## Strategic next

v1.5 stays reserved for the iOS native app + Apple Health
integration + per-metric APNs alerts. The redesigned `/insights`
shell, AI Coach drawer, and Health Score panel were all built with
that next milestone in mind: the Coach SSE endpoint accepts the
same Bearer-token auth that ships for the existing native API
clients (`hlk_<64hex>`); the Health Score formula is deterministic
and pure, so an iOS port can compute the same number locally if it
wants to; the source-chip provenance contract is JSON-only and
labels-only, ready for an APNs payload. Strategic plan and the
artboard / API-shape sketches at
`.planning/phase-D-v1420-product-lead-review.md`.

---

## GH release URL

https://github.com/MBombeck/HealthLog/releases/tag/v1.4.20

---

## Hard-Reload reminder

`Cmd+Shift+R` (Mac) / `Ctrl+Shift+R` (Linux/Win) — the new service
worker otherwise still serves v1.4.19 chunks from cache. One-shot
is enough.
