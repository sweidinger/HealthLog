# v1.5 marathon — state log

Status: phase-2-done
Last update: 2026-05-09T16:10:00+02:00

> Previous milestone: see `docs/audit/v146-summary.md` (v1.4.6 marathon).
> Codex-OAuth iteration v1.4.7 → v1.4.13 landed in CHANGELOG between
> the v1.4.6 release and this marathon kickoff.

## Phase 0 — Bootstrap

- [x] STATE+ROADMAP rewritten for v1.5
- [x] git status clean
- [x] CI status captured (v1.4.13 docker-publish still in_progress; e2e on cfa8ea6 = failure)
- [x] /api/version=1.4.13 confirmed — **DISCREPANCY**: prod still on 1.4.12 because the v1.4.13 GHCR build is mid-flight; phase-1 will need to confirm 1.4.13 lives after the build completes (force-pull recipe per hard-rule #10)
- Result: ok / commit `<filled in by commit step>`
- Detailed report: `.planning/phase-0-report.md`

## Phase 1 — Verify Codex-OAuth flow end-to-end

- [x] /api/version=1.4.13 confirmed (force-pulled at 13:43 UTC after GHCR builds finished)
- [x] device-start endpoint returns spec-shaped response (`userCode`, `verificationUrl=https://auth.openai.com/codex/device`, `intervalSeconds`)
- [x] prod logs reviewed for codex.\* events (DB row confirms 13:06 connect; v1.4.12 ai_test_body_excerpt captured the original failure)
- [x] gpt-5 model accepted by chatgpt.com backend — actually NO, rejected; switched default to `gpt-5.3-codex` (commit `5df74f7`), live test against Marc's account succeeded
- [x] /tmp/v15-codex-working.png captured showing `/settings/ai` with "ChatGPT connected" badge
- Result: ok / commit `5df74f7 fix(ai): default Codex model to gpt-5.3-codex for ChatGPT-account auth`
- Detailed report: `.planning/phase-1-report.md`

## Phase 2 — v1.4.6 deferred backlog

- [x] T2.1 notification-channel scope of "Wipe all data" — commit `512a6a6`
- [x] T2.2 Berlin TZ DST math in cross-metric joins — commit `cb6a59a`
- [x] T2.3 /api/insights/generate provider-error → 422/503 — commit `5403821`
- [ ] T2.4 status-card-grid test brittleness — deferred to phase 4b
- [x] T2.5 redactSecrets regex word-boundary — commit `d6696cf`
- [ ] T2.6 Backups dedicated admin section — deferred to phase 4b
- [ ] T2.7 /admin/users dedicated sub-route — deferred to phase 4b
- Result: ok / commits `512a6a6 cb6a59a 5403821 d6696cf` (+ format sweep `6b88e56`)
- Detailed report: `.planning/phase-2-report.md`

## Phase 3 — End-to-end test coverage

- [x] Authenticated dashboard render — `e2e/dashboard.spec.ts` — commit `3999ea7`
- [x] Add measurement flow — `e2e/measurement-flow.spec.ts` — commit `3999ea7`
- [x] Settings → KI Codex flow (mocked) — `e2e/codex-flow.spec.ts` — commit `2b6f959`
- [x] Doctor report PDF — `e2e/doctor-report.spec.ts` — commit `a106547`
- [x] Insights generation flow (mocked) — `e2e/insights-generate.spec.ts` — commit `2b6f959`
- [x] Mobile-viewport smoke (Pixel 5) — `e2e/mobile-viewport.spec.ts` — commit `a106547`
- [x] axe-core extended to `/` and `/settings/integrations`; `/admin` parked as `test.fixme()` (admin shell off-limits this phase, restructured by 4b) — commit `ca3c599` (+ a11y fixes `7af1f59`)
- Foundation: seeded test user + storageState fixture — commit `535465c`
- Result: 41/41 active specs green locally (Node 22, fresh DB); 3 skipped (mobile-only spec on desktop project × 2 + `/admin` a11y fixme × 2 projects)
- Detailed report: `.planning/phase-3-report.md`

## Phase 4 — Performance audit

- [x] Playwright capture: /, /settings/integrations, /admin, /insights at desktop+mobile (prod=1.4.13, captured 2026-05-09T14:14Z)
- [x] Report at `docs/audit/v15-performance.md` — commit `41fa203`
- [x] Top 3 wins identified, <30 LOC ones implemented inline:
  - W1 commit `bb2b1de` — defer Recharts ScatterChart imports on `/insights` via `next/dynamic` (~108 KiB initial-JS savings)
  - W2 commit `519e36e` — skip checklist API fetches once onboarding is complete (~950 ms network savings on dashboard)
  - W3 deferred to v1.5.1 — replace Recharts (effort L + needs new dep)
- Result: ok / commits `bb2b1de 519e36e 41fa203`
- Detailed report: `.planning/phase-4-report.md`

## Phase 4b — Admin Panel refactor (Settings-style dynamic routes)

- [x] /admin/[section]/page.tsx + admin-shell sidebar — commit `d8b71b3`
- [x] Sections moved to /admin/<slug> routes (system-status, general, services, integrations, feedback, reminders, users, api-tokens, login-overview, backups, danger-zone) — commit `12b280b`
- [x] T2.6 Backups dedicated admin section + manual run — commit `69c5225`
- [x] T2.7 /admin/users with role filters + force-logout — commit `5957e18`
- [x] i18n keys reorganised under admin.section.<slug>.\* (EN + DE parity) — commit `a34cd8c`
- [x] Sidebar nav expandable Admin group — commit `73965cd`
- [x] Status-card CTAs use real routes (no #anchor) — commit `961e2a9`
- [x] Legacy section-anchor → new route redirect in proxy.ts (path-style only; pure `#fragments` cannot be redirected server-side, callsites rewritten directly) — commit `7a47532`
- [x] Tests: status-card-grid asserts route existence + per-section render smoke + i18n parity (existing) — commit `1a7e3d6`
- [x] Bundle-size win verified architecturally (overview no longer imports section components); `pnpm build` blocked by pre-existing Node 25 issue
- Result: ok / commits `d8b71b3 12b280b 69c5225 5957e18 a34cd8c 73965cd 961e2a9 7a47532 1a7e3d6`
- Detailed report: `.planning/phase-4b-report.md`

## Phase 5 — UX polish

- [x] /admin a11y reactivated — `e2e/a11y.spec.ts` now covers /admin,
      /admin/system-status, /admin/users (no more `test.fixme`); fixed
      duplicate `<PasswordInput>` no-aria-label, icon-only button-name
      violations on /admin/users, empty `<dd>` on the audit-log card
- [x] design-review walkthrough top-10 friction points filed at
      `docs/audit/v15-ux-friction.md`
- [x] CRITICAL/HIGH triage — 6 inline fixes; LOW items deferred to
      v1.5.1 with backlog in the audit doc
- [x] v1.4.6 deferred polish picked up:
      - trend-arrow direction-as-good metric-aware (`directionSentiment`
        prop, `up-good`/`up-bad`/`neutral`)
      - "Remove saved AI key" button with AlertDialog confirmation
      - semantic `--success`/`--warning`/`--info` tokens, migrated
        feedback BUG / published badges, medication status, AI section
        connection badges (charts untouched)
- [x] +2 inline friction items: dashboard quick-add menu disambiguation
      (`Add` collision from phase-3) and `/admin` overview nav landmark
- Result: ok / commits `987ce0d 38f12df 788c8ad 569300e e3a6899
  5ffe750 65cfb27` — `pnpm typecheck && pnpm lint && pnpm test` green
  (97 files / 752 tests)
- Detailed report: `.planning/phase-5-report.md`

## Phase 6 — Multi-agent QA (parallel)

- [ ] superpowers:code-reviewer
- [ ] security review
- [ ] visual / UX review
- [ ] simplify on changed file set
- Detailed report: `.planning/phase-6-report.md`

## Phase 7 — Pre-release verification

- [ ] pnpm typecheck
- [ ] pnpm lint
- [ ] pnpm format:check
- [ ] pnpm test
- [ ] pnpm test:integration
- [ ] pnpm build (Node-25 bug documented if hit)
- [ ] pnpm e2e
- Detailed report: `.planning/phase-7-report.md`

## Phase 8 — Release v1.5.0

- [ ] package.json bumped
- [ ] CHANGELOG entry
- [ ] tag v1.5.0 pushed
- [ ] GHCR build green
- [ ] Coolify deploy + force-pull
- [ ] /api/version=1.5.0 confirmed
- [ ] image digest changed
- [ ] prod smoke screenshots saved
- Detailed report: `.planning/phase-8-report.md`

## Phase 9 — Docs + landing sync

- [x] healthlog-docs updated to v1.5 — Codex device-code rewrite, new
      Backups + Users admin sections, CODEX_MODEL env var, dashboard
      perf note, Codex troubleshooting block (7 files)
- [x] healthlog-landing updated — softwareVersion 1.4.6→1.5.0 in
      JSON-LD, AI-providers copy mentions one-click device-code flow
- [x] both committed + pushed (docs `95a3523`, landing `0c62bb2`)
- Result: ok / docs `95a3523` + landing `0c62bb2` — Coolify
  auto-redeploys docs.healthlog.dev on push
- Detailed report: `.planning/phase-9-report.md`

## Phase 10 — Backfill GitHub releases v1.4.7-v1.4.13

- [x] Releases for v1.4.7..v1.4.13 created from CHANGELOG
- [x] `gh release list --limit 20` confirms v1.4.7..v1.4.13 all present
- Result: ok / 1 release created (v1.4.13 → https://github.com/MBombeck/HealthLog/releases/tag/v1.4.13), 6 already existed (v1.4.7-v1.4.12 were published in real time alongside the Codex-OAuth iteration earlier on 2026-05-09)
- Detailed report: `.planning/phase-10-report.md`

## Phase 11 — Final summary doc

- [ ] docs/audit/v15-summary.md with Marc-Brief
- Detailed report: `.planning/phase-11-report.md`
