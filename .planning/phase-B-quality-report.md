# Phase B — Apply A8 quality findings (v1.4.19)

Wave B follow-on to the A8 write-only audit. Pragmatic triage of
the 78 findings: ship every CRITICAL + every low-risk HIGH inline,
defer the rest to v1.4.20.

## CRITICAL — 6 / 6 fixed

| Finding                                                      | Status | Commit    | Notes                                                                                         |
| ------------------------------------------------------------ | ------ | --------- | --------------------------------------------------------------------------------------------- | ----------------------------- |
| F-01 `formatTimeWindowRange` mixed-language `bis ... Uhr`    | fixed  | `180f46c` | Locale param threaded through medication card + form. TDD: 6 cases.                           |
| F-02 `/admin/login-overview` shows insights events           | fixed  | `dc75fe8` | Section now sets `filter=auth`; action dropdown filtered to `auth.*`. TDD: URL assertion.     |
| F-03 Achievements `Idiot` / `Lazy Boy` titles                | fixed  | `7a6bc81` | Renamed in EN + DE; banned-word regression suite.                                             |
| F-04 Date inputs render mm/dd/yyyy on DE                     | fixed  | `ff6e184` | `lang={locale}` on every native `<input type="date                                            | datetime-local">` in the app. |
| F-05 Admin "Pick a section from the sidebar" wrong on mobile | fixed  | `4feacad` | Dropped sidebar reference in EN + DE welcome subtitle.                                        |
| F-06 Insights legacy CTA verb mismatch                       | fixed  | `d263125` | Legacy-payload button now says "Regenerate" in EN/DE; empty-state "Start analysis" untouched. |

## HIGH — 21 fixed / 4 deferred (target: 15)

| Finding                                          | Status          | Commit / reason                                                                                      |
| ------------------------------------------------ | --------------- | ---------------------------------------------------------------------------------------------------- |
| F-07 thresholds three names                      | fixed           | `1f4d6a2`                                                                                            |
| F-08 page+card title duplicate                   | fixed (partial) | `70ebe32` (danger-zone, feedback). Other affected pages deferred.                                    |
| F-09 backup type raw enum                        | fixed           | `1ae9b9d`                                                                                            |
| F-10 `WITHINGS` rendered ALL CAPS                | fixed           | `1ae9b9d`                                                                                            |
| F-11 `→ User` / `→ Admin` no label               | fixed           | `42b0f11`                                                                                            |
| F-12 mobile user cards no aria-labels            | deferred        | spot-check showed every icon button already has `aria-label` + `title`. _not-an-issue_; see backlog. |
| F-13 mobile sys/dia same heart icon              | fixed           | `876e074`                                                                                            |
| F-14 settings/integrations status duplicated     | deferred        | already shipped in v1.4.19 A5.                                                                       |
| F-15 ntfy in subtitle, missing on board          | fixed           | `3f6e670`                                                                                            |
| F-16 "Configured" + "Enabled" double badge       | fixed           | `876e074`                                                                                            |
| F-17 raw `auth.token.autoissue.native` event-key | fixed           | `bc81fd7`                                                                                            |
| F-18 ISO timestamp in token name                 | fixed           | `713b494`                                                                                            |
| F-19 raw `*` permission badge                    | fixed           | `3f6e670`                                                                                            |
| F-20 admin/feedback dupe subtitle                | fixed           | `3f6e670`                                                                                            |
| F-21 "system-wide" suffix repeated 4×            | fixed           | `3f6e670`                                                                                            |
| F-22 services subtitle misses API toggle         | fixed           | `3f6e670`                                                                                            |
| F-23 mood/achievements DE strings                | deferred        | spot-check showed every label already translated. _not-an-issue_; see backlog.                       |
| F-24 admin/integrations duplicate toggle label   | fixed           | `98cd13c`                                                                                            |
| F-25 `Glitchtip` casing                          | fixed           | `3f6e670`                                                                                            |
| F-26 insights regenerate banner+button conflict  | deferred        | partial overlap with A3 + F-06; per-tile spinner removal owns by v1.4.20 Insights redesign.          |
| F-27 awkward achievements subtitle               | fixed           | `3f6e670`                                                                                            |
| F-28 plural bug "for 1 consecutive days"         | fixed           | `98cd13c`                                                                                            |
| F-29 jargon "(severity x provider)"              | fixed           | `3f6e670`                                                                                            |
| F-30 "Inbox zero" empty-state idiom              | fixed           | `3f6e670`                                                                                            |
| F-31 audit-preview row no link                   | fixed           | `bc81fd7`                                                                                            |

## MED + LOW — 31 + 16 deferred to v1.4.20

Severity-grouped list with file:line in
`.planning/v1420-backlog.md`. Highlights: F-36 status-word
taxonomy, F-49 decimal-separator sweep, F-37/F-38 trailing-colon
form-label sweep — all small but cross-cutting. Ideal pre-work
for the v1.4.20 Insights redesign.

## Final verification

- `pnpm typecheck` — clean.
- `pnpm lint` — 12 warnings, 0 errors. All warnings pre-existing
  baseline (`_request` / `_params` / `err`); zero new from B.
- `pnpm format:check` — 8 files dirty. All `.planning/*` /
  `docs/audit/*` baseline noise pre-existing on `origin/main`
  (verified via `git log` + `git show`); zero source files
  dirty after the commit `ae2f671` prettier sweep.
- `pnpm test --run` — 1669 / 1669 green. Up from 1658
  baseline; +11 from new TDD cases (`time-window-format` 6,
  `achievements-no-insults` 4, `login-overview-auth-filter` 1).
- `pnpm test:integration` — 67 / 67 green.

## Pointers

- v1.4.20 backlog: `.planning/v1420-backlog.md`
- A8 raw findings: `.planning/phase-A8-quality-findings.md`
- Wave A reports: `.planning/phase-A{1,2,3,4,5,6,7}-report.md`

## Commits landed on origin/main

`180f46c`, `dc75fe8`, `7a6bc81`, `ff6e184`, `4feacad`, `d263125`,
`1ae9b9d`, `42b0f11`, `1f4d6a2`, `3f6e670`, `70ebe32`, `98cd13c`,
`876e074`, `bc81fd7`, `713b494`, `ae2f671` — 16 atomic commits.
No `--no-verify`, no `--no-gpg-sign`. Pre-commit hooks green
on every commit.
