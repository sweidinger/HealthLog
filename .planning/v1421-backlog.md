# v1.4.21 backlog

Carry-over from v1.4.20 marathon foundation phases. Pick from this list
when v1.4.21 starts.

## F5 — Best-practice repo audit (deferred MED + LOW)

- **README badges** (LOW). Add a small badge row: build status (GitHub
  Actions), license (AGPL-3.0), latest GHCR tag, container size,
  package-version. Today the README is content-rich but visually
  unanchored. Pure cosmetic.
- **FUNDING.yml** (optional). Skipped because no GitHub Sponsors / Ko-fi /
  OpenCollective profile is configured. Add when the maintainer enables
  one.
- **Repo-root tidy** (LOW). The root currently carries `coverage/`,
  `playwright-report/`, `test-results/` directories which are listed in
  `.gitignore` but render as empty entries during `ls -la`. No action
  needed unless a future audit re-flags.
- **`.gitignore` audit** (LOW). Inherits Next.js + standard Node patterns.
  Spot-check did not surface gaps.
- **Discussions enablement** (LOW). The new `.github/ISSUE_TEMPLATE/config.yml`
  links to `https://github.com/MBombeck/HealthLog/discussions`; verify
  that Discussions is actually enabled on the repository before v1.4.21
  ships, or remove the link.

## FX (cleanup) carry-over

- **Source-comment sweep** (LOW). `src/` has 191 `Marc` references in
  maintainer-internal source comments. Visible to anyone who clones the
  repo. Lower priority than user-rendered surfaces; schedule for a
  hygiene PR.
- **DE+EN bilingual CHANGELOG entries** (MED). v1.4.15-era entries pair
  a German sentence with its English translation by historical design.
  English-only normalisation is a larger rewrite — defer.
- **`CLAUDE.md` + `AGENTS.md` filenames** (MED). Visible at repo root.
  These document AI-agent conventions; renaming is a structural change
  with downstream link impact. Defer until a hygiene PR.

## v1.4.19 backlog passthrough (from `v1420-backlog.md`)

The v1.4.19 quality-of-life audit deferred 31 MED + 16 LOW + 4 HIGH +
4 reconcile-HIGH items into `.planning/v1420-backlog.md`. v1.4.20 picks
selectively (the redesign owns its own scope); the rest moves here on
v1.4.21 kickoff. See that file for the full list.
