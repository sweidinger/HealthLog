# Phase A3 — `/insights` polish + Comparison-switch move (v1.4.19)

Status: complete · 2026-05-09T13:18+02:00

## Marc's concerns (verbatim, 2026-05-10)

1. Comparison-Switch (Vormonat/Vorjahr) sollte nicht im Dashboard sein — kein Platz. Stattdessen in /insights, super dort.
2. /insights hat oben Hero. Darunter "Gesundheitsanalyse" mit Refresh-Button. Darunter "Persönlicher AI Berater" — Titel da aber NICHTS PASSIERT. Das ist verwirrend.
3. "Insights aktualisieren / Neue Generierung lädt / Erklärungsfunktion / Analyse starten" — gefühlt drei Buttons, alle machen das Gleiche.
4. Kleine Kacheln (Gewicht, Blutdruck) auf /insights — duplizieren Dashboard, nehmen nur Platz weg.
5. Comparison-Switch Position auf /insights ist optisch nicht an der richtigen Stelle.
6. Bottom: irgendwelche Texte wie "metric: blood_pressure_sweet" — debug code / unrendered template leak.

## Commits on origin/main

| SHA     | Message                                                                                                                                                                           | Concern |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| b5e9a95 | (A4 sweep) — `<CompareToggle />` removal in `src/app/page.tsx` was swept into A4's AI-prompt commit when our edits raced. Effectively covered.                                    | 1       |
| 60a91af | feat(insights): comparison toggle on-surface in hero meta band — adds `metaSlot` prop to `<InsightsPageHero>`, mounts toggle inline.                                              | 5       |
| 98a3d10 | refactor(insights): single page-level refresh and drop orphan subtitle — drops `onRegenerate` from the page's `<InsightAdvisorCard>` mount + the `aiOverviewTitle` placeholder.   | 2 + 3   |
| 335f288 | refactor(insights): drop duplicate metric tile strip — removes 5-tile grid + dead helpers + `fmt`/`bf` locals. Net `-157` / `+20` lines.                                          | 4       |
| fa91a73 | fix(insights): strip lowercase chart tokens from AI prose — splits `STRIP_TOKEN_REGEX` (`[A-Za-z0-9_]+`) from `PARSE_TOKEN_REGEX` (`[A-Z_]+`).                                    | 6       |
| 5360d3c | test(insights): coverage for v1.4.19 polish changes — commit message landed but the test file was missing because a parallel agent's index race captured only the planning files. |
| f2b21a4 | test(insights): add insights-polish.test.ts (followup to 5360d3c) — actual test file (9 tests), pinning all of the above.                                                         | 7       |

## Verification

- `pnpm test --reporter=dot` — 201 files, **1646/1646 tests pass** (was 1605 before; +41 from this phase, A1, A2, A4–A7).
- `pnpm typecheck` — 0 source-level errors.
- `pnpm lint` — 0 errors / warnings on the files I touched. 12 pre-existing warnings on unrelated routes.
- All 6 commits on origin/main; no `--no-verify`, no `--no-gpg-sign`.

## Notes / surprises

- **Concurrent agents touched the same files mid-session.** A4's `b5e9a95` commit landed the dashboard `<CompareToggle />` removal in the same diff that added the AI-prompt rule (the working-tree pickup raced my Edit). The work is in `origin/main`, just attributed to the AI-prompt commit. Acceptance criterion still met.
- **One commit had to be split.** `5360d3c`'s `git add` for the test file silently raced another agent's index changes and committed only `.planning/phase-A6-*.md` instead. Followup `f2b21a4` lands the actual file.
- **Settings → Dashboard layout backdoor preserved.** `comparisonBaseline` on `DashboardLayout` is unchanged; A5/A6's Settings → Dashboard section still exposes the same Select. Power users on either /insights or / can flip it via Settings; on-surface toggle now lives only on /insights as Marc asked.
- **`<RecommendationCard>` internals untouched.** The per-card "Regenerate" affordance (per v1.4.16 spec) is in `RationaleCard` inside that file and was not touched.
- **Strip vs parse split is permissive only on output.** `parseChartTokens()` still mounts charts only for the 12 uppercase allowlisted tokens. The new lowercase coverage is purely about preventing literal-text leak.

## File deltas

| File                                               | Lines added | Lines removed |
| -------------------------------------------------- | ----------- | ------------- |
| `src/app/insights/page.tsx`                        | +43         | -181          |
| `src/components/insights/insights-page-hero.tsx`   | +22         | 0             |
| `src/components/insights/insight-advisor-card.tsx` | +12         | -5            |
| `src/lib/insights/chart-tokens.ts`                 | +16         | -7            |
| `src/app/__tests__/insights-polish.test.ts`        | +140        | 0             |

Net `-200` lines on the page itself, `+140` lines of guards; `/insights` is significantly leaner without losing any value.

## Out of scope (by design)

- v1.4.20 redesign with AI Coach. The brief is polish-only, so nothing was built toward the new layout.
- A1 (BD-Zielbereich constant 50%) — owned elsewhere; `src/lib/insights/blood-pressure-status.ts` not touched.
- A2 charts mobile audit — owned elsewhere; `src/components/charts/*` not touched.
- A4 AI prompt — owned elsewhere; `src/lib/ai/prompts/*` not touched.
- A5/A6 settings — owned elsewhere; `src/components/settings/*` not touched.
- A7 admin polish — owned elsewhere; `src/components/admin/*` not touched.
