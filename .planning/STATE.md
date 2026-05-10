# v1.4.19 marathon — state log

Status: phase-0-done
Last update: 2026-05-10T12:48+02:00

> Previous milestone: v1.4.18 live (image digest
> `sha256:c636fca7db66…`, `/api/version=1.4.18`).
> Next strategic milestone: v1.4.20 = Insights redesign with AI Coach
> (handoff at `~/Downloads/design_handoff_insights_redesign`).
> v1.5 reserved for iOS app + Apple Health integration.

## Phase 0 — Bootstrap

- [x] STATE+ROADMAP rewritten for v1.4.19
- [x] git status clean
- Result: ok / commit `<sha>`
- Detailed report: `.planning/phase-0-report.md`

## Wave A — Bug fixes + polish (parallel buckets)

### A1 — BD-Zielbereich constant 50% (4th attempt) ✅

- [x] Live-DB audit of Marc's BP measurements (apps-01,
      `db-pg8wggwogo8c4gc4ks0kk4ss-105148113251`): 572 paired
      readings since 2022, last-30d = 50 %, last-7d = 50 %, all-time
      ≈ 10.8 %. Confirmed the headline 50 % cannot be the all-time
      value; it must be a copy of `30T`.
- [x] Root cause: `analytics/route.ts` set
      `bpInTargetPct = windows.last30Days?.pct` — literal copy of the
      `30T` sub-value. `computeBpInTargetWindows` returned only 7d+30d
      so the headline could never legitimately differ.
- [x] Fix: helper returns a third `allTime` window; route fetches all
      paired BP rows and routes the headline through `allTime`.
- [x] TDD: 3 failing unit cases + 1 integration case red→green.
- [x] `pnpm test`: 1640 / 1645 (5 pre-existing A3 failures unchanged).
- [x] `pnpm test:integration`: 67 / 67.
- [x] `pnpm typecheck`: clean. `pnpm lint`: 12 baseline 0 new.
- [x] Commit `a856272` pushed to origin/main first attempt.
- Detailed report: `.planning/phase-A1-report.md`

### A2 — Charts mobile audit (axis-label overflow + X-axis density consistency)

- [ ] Playwright headless against live prod at Pixel 5 + smaller
      viewports
- [ ] "Wochendurchschnitt" + "7T/30T/90T/Alle" tabs wrap-break:
      shorten the label or hide on mobile
- [ ] Medication chart shows every date on X; weight/BMI charts
      sparser. Make consistent across all charts
- [ ] Apply universal x-axis tick-density helper
- Detailed report: `.planning/phase-A2-report.md`

### A3 — /insights polish + Comparison switch move

- [ ] Remove Comparison-toggle from Dashboard (insights only)
- [ ] Re-position Comparison-toggle on /insights (find the right spot
      — research §4 said next to range tabs)
- [ ] Consolidate refresh-buttons (page-level vs card-level — pick
      ONE)
- [ ] "Persönlicher AI Berater" title without content → fix or remove
      (placeholder leaked through?)
- [ ] Remove small BP/Weight tiles on /insights (duplicate of
      dashboard, wastes space)
- [ ] Fix raw "metric: blood_pressure_sweet" template leak at bottom
      (debug code or unrendered placeholder)
- Detailed report: `.planning/phase-A3-report.md`

### A4 — AI prompt anpassen (no "Datengrundlage stark" as default first sentence)

- [ ] Edit `src/lib/ai/prompts/insight-generator.ts`
- [ ] Remove the auto-positive-first-sentence about data quality
- [ ] Only mention data quality when low (helpful: "based on limited
      data, treat with caution") not when fine
- [ ] Update tests
- Detailed report: `.planning/phase-A4-report.md`

### A5 — Settings/Integrations status-UI consolidation (Withings + Mood Log)

- [ ] Single tag top-right per integration: "verbunden · vor X min"
- [ ] Remove redundant container with "verbunden / letzte
      erfolgreiche / letzter Versuch" / bottom "letzter Sync" — pick
      ONE place
- [ ] Mood Log container missing visual divider → add (consistency
      with Withings)
- [ ] Mobile-safe: tag wraps gracefully on Pixel 5
- Detailed report: `.planning/phase-A5-report.md`

### A6 — Settings mobile audit + consistency

- [ ] Playwright headless audit `/settings/account`,
      `/settings/profile`, `/settings/integrations`,
      `/settings/notifications`, `/settings/ai`,
      `/settings/dashboard`, `/settings/export`
- [ ] Equalize input heights (Username/Email/Geburtsdatum)
- [ ] Sprache-Menü positioning consistent
- [ ] Right-side action buttons (Passwort Reset, Tool Neustarten)
      consistent vertical position
- [ ] Spacing between elements consistent
- Detailed report: `.planning/phase-A6-report.md`

### A7 — Admin polish (Feedback, api-tokens 4th attempt, Zielwerte, i18n)

- [ ] Admin Feedback "offen/bestätigt/erledigt/archiviert" tabs has
      spurious mini-scrollbar → remove
- [ ] `/admin/api-tokens` scrollbar 4th attempt: truncate token-name
      with `text-ellipsis` + tooltip on hover (not column-hide)
- [ ] `/admin/api-tokens` "Einklappen" button removed (page only has
      1 section)
- [ ] Admin Zielwerte page: reduce whitespace between overview header
      and values
- [ ] Translate Zielwerte status labels: "Low / On Target / Stable /
      Moderate" → DE
- Detailed report: `.planning/phase-A7-report.md`

### A8 — Quality-of-life audit (write-only, fix-set deferred to inline B agent)

- [ ] Audit descriptions correctness across all pages
- [ ] Find redundancies + missing labels
- [ ] Find UI inconsistencies (text styling, spacing, button
      alignment)
- [ ] Output prioritized list for inline fixing
- Detailed report: `.planning/phase-A8-quality-findings.md`

## Wave B — Apply A8 findings (after A8 completes)

- [ ] Fix CRITICAL/HIGH from quality-of-life audit
- Detailed report: `.planning/phase-B-report.md`

## Wave D — Multi-agent QA + Product-Lead review

- [ ] code-reviewer
- [ ] security review
- [ ] design / UX review
- [ ] senior-dev review
- [ ] simplify
- [ ] Product Lead — strategic for v1.4.20 (Insights redesign roadmap,
      AI Coach feasibility)
- [ ] Reconcile applies CRITICAL/HIGH inline
- Detailed report: `.planning/phase-D-report.md` +
  `product-lead-review.md`

## Phase E — Release v1.4.19

- [ ] Pre-release verify
- [ ] Bump package.json + CHANGELOG
- [ ] Tag + push v1.4.19
- [ ] GHCR build green
- [ ] Coolify deploy
- [ ] /api/version=1.4.19 confirmed
- [ ] Production smoke
- [ ] GH release
- [ ] Docs site + landing site sync
- [ ] `docs/audit/v1419-summary.md` (Marc-Brief)
- Detailed report: `.planning/phase-E-report.md`

---

## Status block — Phase 0 (v1.4.19)

- 2026-05-10T12:48+02:00 — Phase 0 complete. STATE.md + ROADMAP.md
  scaffolded for v1.4.19 marathon (Wave A: A1 BD-Zielbereich constant
  50% 4th attempt, A2 charts mobile audit + universal X-tick-density
  helper, A3 `/insights` polish + Comparison-toggle relocation, A4
  AI-prompt rework, A5 Settings/Integrations status-UI consolidation,
  A6 Settings mobile audit, A7 Admin polish, A8 quality-of-life
  write-only audit; Wave B applies A8 findings; Wave D multi-agent QA
  - Product-Lead briefed for v1.4.20 Insights redesign + AI Coach;
    Phase E release). Previous v1.4.18 / v1.4.17 / v1.4.16 entries
    archived above. Tracked tree clean on entry; four untracked stale
    dotted-segment route directories
    (`src/app/api/export/{full-backup.json,measurements.csv,
medications.csv,mood.csv}/`) left in place — same call as v1.4.16 /
    v1.4.18 Phase 0, they belong to previous milestones. Phase 0 commit
    contains only `.planning/STATE.md`, `.planning/ROADMAP.md`,
    `.planning/phase-0-report.md`. v1.4.20 reserved for Insights
    redesign with AI Coach (handoff at
    `~/Downloads/design_handoff_insights_redesign`); v1.5 reserved for
    iOS app + Apple Health.

- 2026-05-10T12:59+02:00 — Wave A / A4 complete. Removed the
  default-positivity opener about data quality from the AI insights
  system prompt. Added GROUND RULE 7 in both EN + DE locales of
  `src/lib/ai/prompts/insight-generator.ts` forbidding "Your data
  foundation is strong" / "Datengrundlage ist sehr stark" style
  openers; data-quality caveats now allowed only when n<7 in the
  analyzed window, recencyDays>14, or a coverage gap biases the
  comparison. PROMPT_VERSION bumped 4.16.1 → 4.19.0 so feedback
  aggregation can attribute responses to the new rule. New test file
  `src/lib/ai/__tests__/no-default-positivity-opener.test.ts` (9
  tests, all green) pins the rule + thresholds + banned phrases in
  both locales. Existing PROMPT_VERSION assertions in
  `medical-reference-prompt.test.ts` relaxed from `/4\.16\.\d+/` to
  `/4\.\d+\.\d+/`. Single commit `b5e9a95` on `origin/main`. Smoke
  verification deferred to post-deploy (cached payloads carry the
  old PROMPT_VERSION; the row's `promptVersion` distinguishes
  pre/post 4.19.0). Detailed report:
  `.planning/phase-A4-report.md`. Cross-agent race: pre-commit hook
  bundled A3's `src/app/page.tsx` edits into my commit — same
  shared-cwd race documented across earlier marathons; A3's edits
  are correct on `origin/main`.

---

## Previous milestone — v1.4.18 (completed 2026-05-10T11:45+02:00)

LIVE at https://healthlog.bombeck.io · `/api/version=1.4.18` · image
digest `sha256:c636fca7db66…` (was v1.4.17: `sha256:936e9cf25b2d…`).
Full Marc-Brief at `docs/audit/v1418-summary.md`. Backlog seeded to
`.planning/v1419-backlog.md` (1 HIGH i18n bundle leak + MED/LOW) and
`.planning/v15-backlog.md` / `.planning/phase-D-v1418-product-lead-review.md`
(strategic).

Phases run during v1.4.18 marathon:

- Phase 0 — Bootstrap (STATE+ROADMAP for v1.4.18)
- Wave A — A1 BD-Zielbereich tile sub-values, A2 admin-shell mobile
  strip scrollbar, A3 chart visual revert + per-chart overlay
  toggles
- Wave B — B1 achievements expansion (38 → 59, +6 hidden, discovery
  filter, opaque hidden cards)
- Wave D — Multi-agent QA + reconcile (1 CRITICAL cleared, 8 of 10
  HIGH fixed inline, 1 HIGH deferred to v1.4.19)
- Phase E1-E3 — Release v1.4.18 (tag, GHCR both green, Coolify deploy
  via force-pull, GH release, docs+landing sync, Marc-Brief)

---

## Previous milestone — v1.4.17 hotfix (live 2026-05-10T07:58+00:00)

`/insights` TypeError on legacy cached payload — `isLegacyInsightPayload()`
flag + advisor card short-circuit + defensive `stripChartTokens` /
`parseChartTokens`. Three commits: `79bfa27` (fix), `adab80a`
(release), `da7070e` (prettier). Detailed report:
`.planning/phase-v1417-hotfix-report.md`.

---

## Previous milestone — v1.4.16 (completed 2026-05-10T04:05+02:00)

Full report: `docs/audit/v1416-summary.md`. v1.5 backlog seeded at
`.planning/v15-backlog.md`.
