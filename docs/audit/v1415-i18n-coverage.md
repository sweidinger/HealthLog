# v1.4.15 — i18n coverage audit

**Date**: 2026-05-09
**Phase**: C4
**Scope**: every `t("…")` / `useTranslations()` call in `src/`
vs. `messages/en.json` and `messages/de.json`. Goal: ensure every
v1.4.15-introduced key (Wave A1–A4, B-mobile, B1–B6, C2, C3) has a
non-empty, non-placeholder translation in BOTH locales and follows the
namespace conventions baked in by the Phase 4b admin reorg.

## Method

1. `grep -rh -oE 't\("[a-zA-Z][a-zA-Z0-9_.-]*"' src/` — extract every
   call-site key (1318 unique).
2. Walk both JSON files manually (no `JSON.parse`, since duplicate keys
   silently shadow earlier values) — same parser used by the existing
   `i18n-locale-integrity.test.ts`.
3. Compare:
   - **drift**: keys in EN but not DE, or vice versa
   - **empty**: `value === ""`
   - **placeholders**: `value === keyLastSegment`, or `/\b(TODO|FIXME|XXX|TBD)\b/i`
4. Cross-locale identical strings checked per-namespace — many are
   legitimate (brand names, ICU placeholder strings, anglicisms used
   in DE) so the heuristic only flagged for review, not auto-fix.

## Findings

| Check                              | Count | Notes                            |
| ---------------------------------- | ----: | -------------------------------- |
| Total keys (EN)                    |  1817 |                                  |
| Total keys (DE)                    |  1817 |                                  |
| Keys only in EN                    |     0 | full parity                      |
| Keys only in DE                    |     0 | full parity                      |
| Empty values (EN)                  |     0 |                                  |
| Empty values (DE)                  |     0 |                                  |
| TODO/FIXME placeholders (EN)       |     0 |                                  |
| TODO/FIXME placeholders (DE)       |     0 |                                  |
| Used-in-`src/` but missing in EN   |     0 | after excluding allow-list below |
| EN==key (last segment, both EN+DE) |     5 | all legitimate (see §Legitimate) |

### Allow-list — used-key matches that are NOT i18n keys

These appeared in the grep but are deliberately excluded:

- `job.*` — Wide Event names passed to `withBackgroundEvent("job.x")`,
  not i18n.
- `scheduler.tick` — Wide Event name.
- `empty.measurements.*` — JSDoc `@example` block in
  `src/components/ui/empty-state.tsx`, never executed.
- `settings.testConnection.errors.` — dynamic concat root in
  `src/components/settings/test-connection-button.tsx`. Concrete
  error-codes (`generic`, `credentials_rejected`, `timeout`, …) are
  all present.
- `nope.also.missing`, `telegram.__definitely_missing__` — vitest
  fixtures asserting fallback behaviour
  (`src/lib/__tests__/server-translator.test.ts`).

### Legitimate EN==DE==key cases

5 entries where both locales return the key's last segment unchanged:

| Path                            | Value     | Reason                                              |
| ------------------------------- | --------- | --------------------------------------------------- |
| `settings.ntfy`                 | `ntfy`    | brand name, not translated                          |
| `classifications.bp.Optimal`    | `Optimal` | identical word in EN and DE                         |
| `classifications.bp.Normal`     | `Normal`  | identical                                           |
| `classifications.pulse.Normal`  | `Normal`  | identical                                           |
| `classifications.bodyFat.Fitness` | `Fitness` | identical (anglicism in DE medical/fitness context) |

A further 25 entries are EN==key but DE has an actual translation
(`classifications.bmi.Underweight` → `Untergewicht`, etc.) — these are
fine.

### v1.4.15 new namespaces — coverage check

| Namespace                       | Origin         | EN keys | DE keys | Drift | Empty |
| ------------------------------- | -------------- | ------: | ------: | ----: | ----: |
| `admin.section.backups.*`       | B1 backups     |      35 |      35 |     0 |     0 |
| `achievements.*`                | B4             |     106 |     106 |     0 |     0 |
| `onboarding.tour.*`             | B5             |      18 |      18 |     0 |     0 |
| `admin.overview.*`              | A2             |      16 |      16 |     0 |     0 |
| `settings.notificationStatus.*` | B3             |      13 |      13 |     0 |     0 |
| `settings.integrationStatus.*`  | B2             |       6 |       6 |     0 |     0 |
| `doctorReport.*`                | B6             |      90 |      90 |     0 |     0 |
| `quickAdd.*` (`common.add` etc) | A3             | (`common`) |  —    |     0 |     0 |

### Naming consistency

CLAUDE.md note: Phase 4b moved admin keys under
`admin.section.<slug>.*`. Verified all v1.4.15-introduced admin
sections follow that pattern:

```
admin.section.{system-status,general,services,integrations,
              feedback,reminders,users,api-tokens,login-overview,
              backups,danger-zone}
```

Pre-Phase-4b legacy keys remain at the flat `admin.*` namespace (e.g.
`admin.bugReportRepo`, `admin.userManagement`) — those are out of
scope for this audit (renaming would touch many components for zero
behavioural gain). New B-agent code did NOT introduce inconsistent
flat keys; e.g. B5 used `onboarding.tour.*` (not `tour.*`); B4 used
`achievements.*` (not flat `badges.*`); B1 used `admin.section.backups.*`
(not flat `backups.*`); B2/B3 added `settings.{integrationStatus,notificationStatus}.*`
under the existing `settings` umbrella.

## Outcome

**Zero gaps closed**. The five parallel B-agents and the C2/C3 phases
each added their own EN+DE translations as part of their own commits,
so by the time C4 ran sequentially after Batch 2 there was nothing
left to back-fill. The audit instead converted to a quality-assurance
sweep: tightening `i18n-locale-integrity.test.ts` to lock in the
non-empty + non-placeholder invariants going forward.

## Test guard

`src/lib/__tests__/i18n-locale-integrity.test.ts` is extended with:

- assertion that no value in either locale file is the empty string
- assertion that no value equals its key's last segment (with an
  explicit allow-list for the 5 legitimate cases above)
- non-fatal warning (logged via `console.warn` in CI) for values
  containing `\bTODO\b` / `\bFIXME\b` / `\bXXX\b`

These guards prevent regression: any future agent that ships a
`"key": ""` or `"bugReport": "bugReport"` value will see CI go red.
