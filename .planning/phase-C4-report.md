# Phase C4 — i18n coverage audit (v1.4.15)

**Status**: done  
**Date**: 2026-05-09T21:45+02:00  
**Commit**: `01a10de` `test(i18n): non-empty + non-placeholder parity assertion`  
**Audit doc**: [`docs/audit/v1415-i18n-coverage.md`](../docs/audit/v1415-i18n-coverage.md)

## Result — 0 gaps closed

The five parallel B-agents and the C2/C3 phases each shipped their own
EN+DE translations as part of their own commits. By the time C4 ran
sequentially after Batch 2, both locale files were already in perfect
parity:

| Check                            |                                                  Count |
| -------------------------------- | -----------------------------------------------------: |
| Total keys (EN)                  |                                                   1817 |
| Total keys (DE)                  |                                                   1817 |
| Keys only in EN                  |                                                      0 |
| Keys only in DE                  |                                                      0 |
| Empty values                     |                                                      0 |
| TODO/FIXME placeholders          |                                                      0 |
| Used in `src/` but missing in EN | 0 (after JSDoc/dynamic-prefix/test-fixture allow-list) |

All v1.4.15-introduced namespaces (`admin.section.backups.*`,
`achievements.*`, `onboarding.tour.*`, `admin.overview.*`,
`settings.notificationStatus.*`, `settings.integrationStatus.*`,
`doctorReport.*`) are fully populated in both locales. New B-agent
keys all follow the established conventions — no flat-namespace
inconsistencies introduced; the `admin.section.<slug>.*` Phase 4b
pattern is honoured by every new admin section (B1 backups in
particular).

## What this commit changes

`src/lib/__tests__/i18n-locale-integrity.test.ts` — extended with
three new assertion blocks (5 new test cases):

1. **No empty values** — fails on `"key": ""` in either locale.
2. **No placeholder values** — fails when `value === keyLastSegment` in
   BOTH locales simultaneously, with an explicit `PLACEHOLDER_ALLOWLIST`
   covering the 5 legitimate cases (`settings.ntfy`,
   `classifications.bp.Optimal`, etc — brand names + identical EN/DE
   technical terms). EN-only matches like `"of": "of"` (where DE has
   `"von"`) are deliberately NOT flagged because they're natural for
   keys named after EN words.
3. **No TODO/FIXME/XXX/TBD markers** — fails on those four words as
   whole-word matches inside any value.

8 tests pass (was 3; +5 new). Full unit suite 977/977 green.
Typecheck has 3 pre-existing errors in `dashboard-layout.test.ts`
(owned by A4, untouched). Lint clean for C4 files (11 pre-existing
warnings, none new).

## What this commit does NOT change

- `messages/en.json` + `messages/de.json` are untouched — no
  back-fill needed.
- No source-component renaming for naming-consistency; no offending
  flat keys found to fix.
- The 25 EN==key cases where DE has a real translation
  (e.g. `"insights.taken": "taken"` / `"genommen"`) are left as-is —
  they're correct.

## Cross-agent observations

The shared-cwd race documented under A2 / A4 / B-mobile / B1 / B2 / B3 /
B4 / B5 / B6 / C2 was avoided this round: C4's diff was small (2
files: 1 new audit doc, 1 test file edit) and Batch 2 had finished
before C4 started, so `git add <pathspec>` + `git commit` + `git push`
landed cleanly on first attempt — no rebase, no force-push.

v1.4.16 should still adopt `superpowers:using-git-worktrees` per agent
to eliminate the race for future marathons.

## Verification commands

```bash
pnpm test src/lib/__tests__/i18n-locale-integrity.test.ts  # 8/8
pnpm test                                                   # 977/977
pnpm lint                                                   # 0 errors, 11 warnings (pre-existing)
```
