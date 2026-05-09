# v1.4.6 marathon — state log

Status: **bootstrapped** (2026-05-09 ~01:25)

Update at every phase boundary so `cat .planning/STATE.md` is the truth.

## Phase 0 — Bootstrap

- [x] `.planning/PROJECT.md`
- [x] `.planning/ROADMAP.md`
- [x] `.planning/STATE.md`
- [ ] commit `chore(planning): bootstrap v1.4.6 marathon`

## Phase 1 — CI green

- [ ] reproduce e2e failure locally
- [ ] root-cause + fix
- [ ] verify CI green

## Phase 2 — Tier 1 fixes (T1–T9)

- [ ] T1 trend-card w-full (in working tree)
- [ ] T2 muted-foreground colour split
- [ ] T3 primaryRecommendation chart-token rendering
- [ ] T4 aiBaseUrl provider leak fix + test
- [ ] T5 /api/insights/generate 502 → 422
- [ ] T6 admin status-card hrefs + tighten test
- [ ] T7 bug-report toggle gate (api/feedback + /bugreport/status)
- [ ] T8 data-wipe scope + audit-log preservation
- [ ] T9 KI per-card 360 daily + 24 monthly (7 generators)

## Phase 3 — Chart bucketing

- [ ] research recharts patterns
- [ ] `bucketTimeSeries` helper + tests
- [ ] chart header chip + i18n

## Phase 4 — Tier 2 polish

- [ ] P1–P5 trend-card + chart card (single commit)
- [ ] P6 welcome subtitle
- [ ] P7 auth-shell pb buffer
- [ ] P8 empty-state title color
- [ ] P9 onboarding font-mono drop
- [ ] P10 medications card padding
- [ ] P11 redact `sk-(ant-)?`
- [ ] P12 idempotency exclusion
- [ ] P13 cache-before-rate-limit
- [ ] P14 codex-client structured error
- [ ] P15 model presets (drop gpt-5/o3-mini)
- [ ] P16 ai-section i18n strings
- [ ] P17 feedback-inbox dracula colours
- [ ] P18 danger-zone success heuristic
- [ ] P19 useSystemStatus / useAdminSettings isError UI
- [ ] P20 status-overview Promise.allSettled

## Phase 5 — QA

- [ ] superpowers:code-reviewer
- [ ] Plan as senior security reviewer
- [ ] Plan as senior design reviewer
- [ ] simplify pass

## Phase 6 — Pre-release verification

- [ ] typecheck / lint / format / test / integration / build / e2e
- [ ] before-screenshots vs prod

## Phase 7 — Release

- [ ] package.json 1.4.6
- [ ] CHANGELOG `[1.4.6]` block
- [ ] tag + push
- [ ] GHCR build green
- [ ] Coolify deploy + finished
- [ ] /api/version=1.4.6, image digest changed

## Phase 8 — Releases

- [ ] gh release create v1.4.2…v1.4.6
- [ ] GHCR untagged cleanup

## Phase 9 — Docs / landing

- [ ] healthlog-docs synced to v1.4.6
- [ ] healthlog-landing minimal update

## Phase 10 — Summary

- [ ] `docs/audit/v146-summary.md` with German Marc-brief on top
