# Phase 0 — v1.4.15 marathon bootstrap

Status: **done**
Timestamp: 2026-05-09T20:06:00+02:00
Commit: see `chore(planning): bootstrap v1.4.15 marathon` on origin/main.

## What this phase did

Pivoted `.planning/STATE.md` and `.planning/ROADMAP.md` from the
completed v1.4.14 marathon (which shipped at 18:35+02:00 today and is
LIVE on https://healthlog.bombeck.io with `/api/version=1.4.14`, image
digest `sha256:0ced46004a54…`) to the v1.4.15 marathon scaffold.

The v1.4.14 entries were archived in-place: STATE.md keeps a one-line
"previous milestone" reference plus a phase-summary block; ROADMAP.md
keeps the full v1.4.14 phase table below the active v1.4.15 table. No
information lost — `docs/audit/v1414-summary.md` remains the canonical
release record.

Phases scaffolded for v1.4.15: A1-A5 (5 quick-fix buckets), B1-B6 (6
bigger features), C1-C5 (hardening — including AI/Codex
hallucination-resistance C1 and Coolify auto-deploy C2), D (multi-agent
QA, write-only), and E (release).

## Pre-flight checks

- Codex protocol spec at `docs/codex-protocol-spec.md` confirmed
  present (741 LOC) — canonical reference for Phase C1 AI hardening.
- Backlog at `.planning/v1415-backlog.md` confirmed present (HIGH /
  MEDIUM / LOW findings from the v1.4.14 phase-6 multi-agent QA).
- Summary at `docs/audit/v1414-summary.md` confirmed present (Marc-Brief
  + 53-commit table).

## Working tree

`git status` shows `main` up to date with `origin/main`. 10 untracked
files from the v1.4.14 marathon (phase-4-visual-verify, phase-6-{code-
review, design, reconcile, security, simplify}-findings, phase-8 / 9 /
10, v1414-rebrand-report) were intentionally left untracked — they
belong to the previous milestone, not this one. Folding them into the
Phase 0 commit would muddy v1.4.15 history. The Phase 0 commit
contains ONLY `.planning/STATE.md`, `.planning/ROADMAP.md`,
`.planning/phase-0-report.md`.

## Constraints honoured

- Single chore commit `chore(planning): bootstrap v1.4.15 marathon`
  with `Co-Authored-By: Claude Opus 4.7 (1M context)`.
- No `--no-verify`, no `--no-gpg-sign`.
- Only `.planning/` files touched. No source files modified.
- Pushed to `origin/main`.
