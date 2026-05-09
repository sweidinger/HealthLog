# Phase 0 — Bootstrap report

Status: **done**
Timestamp: 2026-05-09T15:25:00+02:00
Commit: see `chore(planning): bootstrap v1.5 marathon` on origin/main.

## Working tree

`git status` clean, branch `main` up to date with `origin/main`.

## Recent commits (`git log --oneline -15`)

```
cfa8ea6 fix(ai): use plain gpt-5 model slug for ChatGPT-account auth
e4a07bc fix(ai): complete Codex backend protocol implementation per spec
e0de659 fix(ai): CodexClient consumes SSE stream from chatgpt.com backend
68e5797 fix(ai): Codex backend request body matches OpenAI Responses schema
3dbc8af fix(ai): device-code flow uses OAuth access token directly (v1.4.8 follow-up)
19eb1d9 fix(ai): switch ChatGPT-OAuth to device-code flow (v1.4.7-followup)
2f7f487 fix(ai): Codex OAuth flow — correct issuer + api-key exchange
3bca826 docs(release): v1.4.6 marathon summary
a852612 chore(release): v1.4.6
02b9955 chore(style): repo-wide prettier sweep before v1.4.6 tag
6757518 fix(qa): apply pre-release multi-agent QA findings
dc4507a fix(admin/status-overview): one failed probe no longer blanks the grid
2654337 fix(admin): surface query errors instead of an infinite spinner
86a4b52 fix(admin): danger-zone result colour driven by mutation state
505f318 style(admin): switch feedback-category badges to dracula tokens
```

The full v1.4.7 → v1.4.13 Codex iteration is in commits `2f7f487` →
`cfa8ea6`. v1.4.13 (`cfa8ea6`) is tagged but its docker-publish run
is still in_progress, so production has not yet swung over.

## CI status (`gh run list --limit 8`)

- v1.4.13 SHA `cfa8ea6`: docker-publish **in_progress** (two runs queued —
  one is the duplicate that GHCR triggers per tag); e2e **failure** (the
  e2e on the v1.4.13 SHA — known, not a hard release gate per v1.4.6
  marathon doctrine, but worth a phase-1 follow-up if it persists);
  Integration tests **success**; Security & Quality **success**.
- v1.4.12 SHA `e4a07bc`: docker-publish **success** (×2), Integration
  tests **success** — i.e. v1.4.12 is the latest fully published image.

## Production state

`curl https://healthlog.bombeck.io/api/version` returns
`{"version":"1.4.12", ...}` — **production is one tag behind HEAD**.
Cause: the v1.4.13 docker-publish workflow is still building, and even
once it finishes, the Coolify-deploy quirk (hard-rule #10) means we
need to force-pull on apps-01 before /api/version flips to 1.4.13.
Phase 1 owns that confirmation step.

## Files written

- `.planning/STATE.md` — rewritten for v1.5 marathon, all phases stubbed.
- `.planning/ROADMAP.md` — v1.5 milestone with phases 0–11 lifted from
  the marathon prompt.
- `.planning/phase-0-report.md` — this file.

`PROJECT.md` left untouched (no v1.5-specific changes needed yet).
