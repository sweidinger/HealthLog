# Phase 0 — v1.4.16 marathon bootstrap

Status: **done**
Timestamp: 2026-05-09T23:12:52+02:00
Commit: `chore(planning): bootstrap v1.4.16 marathon` on origin/main.

## What this phase did

Pivoted `.planning/STATE.md` and `.planning/ROADMAP.md` from the
completed v1.4.15 marathon (which shipped today at 22:50+02:00 — see
`docs/audit/v1415-summary.md` for the Marc-Brief, commit table, image
digest `sha256:ace7d441f47b…`, deferred items) to the v1.4.16 scaffold.

STATE.md now lists Wave A (A1–A8 quick fixes), Wave B (B1–B7 quality-leap
features), Wave C (catch-up of 8 deferred HIGH from Phase D + 5 mobile
MEDs + Coolify image-digest auto-deploy + docker-publish main-branch
hang root-cause), Wave D (5 reviewers + Product-Lead + reconcile), Phase
E (release). ROADMAP.md mirrors the heading-level structure with one-
line Goal cells; v1.4.15 + v1.4.14 entries archived below the active
table.

## Working-tree sanity

`git status` showed 22 modified `.planning/*.md` files at session start
— a stray re-run of `prettier --write .planning/` had corrupted the
v1.4.15-shipped reports (markdown list-marker `+` flipped to `-`,
breaking semantic content like "+1 e2e" → "-1 e2e" and "command +
flag" lists). Discarded via `git checkout -- .planning/`. Tracked
working tree now matches `origin/main`. Untracked phase reports from
v1.4.14 + v1.4.15 (15 files) left in place — they belong to previous
milestones and are explicitly out-of-scope for v1.4.16 Phase 0.

## Spec re-read

Re-read `docs/codex-protocol-spec.md` as required (canonical reference
for any v1.4.16 AI work — Wave-A A7 rate-limit + cache, Wave-B B5
hallucination-hardening v2 medical-grounding + multi-provider). §7b
slug-drift defence already shipped in v1.4.15 C1; v1.4.16 builds on
top.

## Backlog inventoried

`.planning/v1416-backlog.md` confirmed present (8 deferred HIGH + 39
MED/LOW + 4 simplify-no + 3 process items, severity-grouped, with
file:line references). Wave C catch-up references this file.

## Marc-status

Speed mattered. Working-tree corruption tax was 30 seconds. Phase 0
commit contains only `.planning/STATE.md` + `.planning/ROADMAP.md` +
`.planning/phase-0-report.md`.
