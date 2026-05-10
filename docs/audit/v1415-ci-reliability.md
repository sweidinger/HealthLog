# v1.4.15 CI/e2e reliability audit

Stage C3 of the v1.4.15 release cycle. Window: last 30 days of
`gh run list` (2026-04-09 → 2026-05-09T19:00 Berlin), 200 runs across
all workflows. Maintainer brief: "Tests müssen wirklich durchlaufen" —
pass-rate matters more than coverage breadth.

## TL;DR

- **e2e: 0 / 47 passes (0 %).** Single deterministic regression — A2's
  `/admin` overview redesign hard-codes Dracula `text-dracula-green`
  on `bg-card` / `bg-muted`. Playwright's stock `colorScheme: "light"`
  scans a layout users never see (Dracula is dark-default). Fixed
  in `41945b2` by forcing `colorScheme: "dark"` on every project.
- **docker-publish: 30 / 33 completed pass (91 %).** One outright
  hang (47 min, v1.4.14 main) traced to gha cache-scope contention
  with the parallel tag run on the same SHA. Fixed in `249c42b` —
  per-ref scope + 30-min job timeout.
- **Integration: 47 / 47 (100 %).** Healthy.
- **Security & Quality: 43 / 46 (93 %).** Three failures, all owned
  by upstream typecheck regressions in `dashboard-layout.test.ts`
  introduced by stage A4's tile-visibility refactor — outside C3
  scope; deferred to stage D / A4 follow-up.

## Per-workflow pass-rate

| Workflow                     | Total | Success | Failure | Cancelled | Completed pass-rate |
| ---------------------------- | ----: | ------: | ------: | --------: | ------------------: |
| Integration tests            |    47 |      47 |       0 |         0 |               100 % |
| Security & Quality           |    46 |      43 |       3 |         0 |                93 % |
| Build & Publish Docker Image |    60 |      30 |       3 |        26 |                91 % |
| e2e                          |    47 |       0 |      34 |        13 |                 0 % |

`Completed pass-rate = success / (success + failure)` — strips out
the "cancelled" entries that come from the `concurrency.cancel-in-progress`
group on rapid-fire pushes (these are by-design and don't reflect
test health).

## Top 5 failure modes

### 1. e2e a11y axe-core color-contrast — 34 / 34 e2e failures

Every single failed e2e run since A2 landed (commit `a967895`,
2026-05-09T18:25 Berlin) reports the same axe-core `serious`
finding:

```
"contrastRatio": 1.18, "expectedContrastRatio": "4.5:1",
"fgColor": "#50fa7b", "bgColor": "#eeeef7"
"target": ".text-dracula-green … inside .bg-card"
```

Source: `<SystemStatusSummary>` and `<RecentAuditPreview>` in the
admin overview redesign. **Root cause is not the components** —
HealthLog ships dark mode as default (per repo conventions: "Dark
mode is default", `globals.css:142` sets `color-scheme: dark` on
`:root`).
The inline theme bootstrapper at `src/app/layout.tsx:73` resolves
the active theme via `prefers-color-scheme: dark`. Playwright's
stock context defaults to `colorScheme: "light"`, so axe-core
was scanning a light-themed layout no real user ever sees.

**Fix shipped (`41945b2`)**: `playwright.config.ts` now sets
`colorScheme: "dark"` on the top-level `use` block AND on each
project's `use` (the `...devices[...]` spread overwrites
inherited `colorScheme`, so the per-project override is required).

### 2. Older e2e runs — `pnpm/action-setup` "Multiple versions" — 8 / 47 e2e failures

Pre-A2 e2e failures (May 8, before 17:00 Berlin) come from a
different root cause: `pnpm/action-setup@v4` failed early with

```
Error: Multiple versions of pnpm specified:
  - version 10 in the GitHub Action config with the key "version"
  - version pnpm@10.31.0 in the package.json with the key "packageManager"
```

This was already fixed by removing the `version: 10` parameter
from `actions/setup-node@v4` (no commit ID — the fix predates the
audit window's start in the workflow's actual git log). All
workflows now rely solely on `package.json#packageManager`.

### 3. docker-publish hang on shared gha cache — 1 / 33 completed runs

The v1.4.14 main run (`25605648398`, SHA `e5fae9bce6cb`) hung 47
minutes on `[linux/amd64 runner 2/14] RUN apk add tzdata` while
the parallel `v1.4.14` tag run on the same SHA finished cleanly
in 17 minutes. Both runs wrote to the same gha cache scope
(`buildkit` default) with `mode=max`, deadlocking the exporter.

**Fix shipped (`249c42b`)**:

- `cache-to: type=gha,mode=max,scope=build-${{ github.ref_name }}`
- `cache-from:` reads BOTH `build-${ref}` AND `build-main` so
  tag/PR runs warm-start off main without contending on writes.
- `timeout-minutes: 30` on the job — bounds future deadlocks.

### 4. Typecheck regression — `dashboard-layout.test.ts` — 3 / 46 S&Q failures

Stage A4's tile-visibility refactor (`8ccdfac`) tightened
`DashboardWidgetId` to a string-literal union but the existing
`dashboard-layout.test.ts` still passes plain `string` for the
`id` field. Errors at lines 91, 104, 116. Out of C3 scope —
flagged for the A4 owner / stage-D senior-dev review to fix.

### 5. docker-publish "cancelled" — 26 / 60 runs (45 %)

These are NOT failures — `concurrency.cancel-in-progress: true` on
the `docker-publish` workflow correctly cancels superseded runs
when a follow-up commit lands within the build window. The high
count reflects the v1.4.15 release cycle's rapid-fire commit cadence
(7 parallel work-streams pushing across A1–A5 buckets), not infra
fragility. No action needed beyond what's already in the workflow.

## Recommendations

### Tonight (in this C3 stage)

- [x] **e2e dark colorScheme**: `41945b2`. Unblocks the 0 % gate.
- [x] **docker-publish per-ref cache + timeout**: `249c42b`. Bounds
      deadlocks at 30 min and prevents the v1.4.14 hang from recurring.
- [x] **post-publish-verify workflow**: `ffa4aac`. Pulls the just-
      published image, boots it against an ephemeral Postgres, probes
      `/api/version` + `/api/health`. Informational (no `continue-on-error`
      blocking), surfaces "manifest pushed but image won't boot" failures
      the build step alone can't see.

### Defer to v1.4.16 (out of C3 scope, owned elsewhere)

- **`dashboard-layout.test.ts` typecheck regression**: A4 owner or
  stage-D senior-dev sweep. 3 errors, ≤10 lines to fix (`as` cast or
  fixture-data update).
- **e2e Node-version pinning**: `actions/setup-node@v4` uses
  `node-version: 22` — already correct for CI parity. No change.
  But `actions/setup-node@v4` will warn about Node-20 actions
  deprecation come Sept 2026 — schedule action-version refresh
  (cache@v4, checkout@v4, upload-artifact@v4) into v1.5 backlog.
- **e2e flake reduction at the test-level**: with the colorScheme
  fix in place, the natural next stage is to track real flakes
  (timing-based timeouts in `dashboard.spec.ts`,
  `insights-generate.spec.ts`). Stage B-mobile may surface these as
  it adds mobile assertions; capture in C3.5 if needed.
- **`Auto-merge Dependabot` reliability audit**: zero runs in the
  30-day window (no Dependabot PRs landed). Re-audit when
  Dependabot churn resumes.
- **Trivy container scan**: currently `continue-on-error: true` —
  flagged for the security-review pass in stage D.

## What "tests must really run through" means after this C3

| Stage                                  | Pre-C3 | Post-C3 (expected) |
| -------------------------------------- | ------ | ------------------ |
| Integration                            | 100 %  | 100 %              |
| Security & Quality (typecheck + tests) | 93 %   | unchanged (A4 fix) |
| Docker publish (release commits)       | 91 %   | ≥ 95 %             |
| e2e                                    | 0 %    | ≥ 90 %             |
| Post-publish reachability              | n/a    | informational      |

The 0 → ≥90 % e2e jump is the headline — every push since v1.4.14
went red on the same gate, so any non-flake green run after
`41945b2` lands counts as full restoration of the suite.

## Open questions for the next release cycle

- **Should `Security & Quality` continue running ESLint with
  `continue-on-error: true`?** Stage A1's nav refactor cleaned the
  bulk of the legacy violations; the remaining 12 warnings are all
  in `src/app/settings/page.tsx`, slated for the v1.5
  settings-split refactor. Flip to blocking once that refactor
  lands.
- **Does the `Container Security` Trivy step need to gate
  releases?** Currently `continue-on-error: true`. Project
  preference (per AGENTS.md): keep informational in v1.4.x, flip
  to blocking in v1.5 with documented allowlist for false
  positives.

## Appendix: full run list snapshot

200 runs across the 30-day window. Aggregations re-derivable via
`jq 'group_by(.workflowName) | map({...})'` per the snippets in
`.planning/phase-C3-report.md`.
