# v1.4.20 Marathon — Session Handoff

This is the prompt to paste into a fresh Claude Code session to start the v1.4.20 marathon. v1.4.19 is live in production. v1.4.20 is the big Insights redesign with AI Coach.

---

## Quick context (read by the agent at session start)

- **Production:** v1.4.19 live at https://healthlog.bombeck.io
- **Last full release report:** `docs/audit/v1419-summary.md`
- **Strategic plan for v1.4.20:** `.planning/phase-D-v1419-product-lead-review.md` (5 phases B1–B5)
- **Design handoff:** `~/Downloads/design_handoff_insights_redesign/` (7 artboards + README)
- **v1.4.20 backlog of deferred items:** `.planning/v1420-backlog.md`
- **v1.5 reserved for:** iOS native client + Apple Health integration
- **Memory directives (auto-loaded):** `/Users/marc/.claude/projects/-Users-marc-Projects-HealthLog/memory/MEMORY.md`

## v1.4.20 scope — pre-flight foundation work BEFORE Insights work

These foundation tasks **MUST** happen first in the session before any feature work:

### F1 — Branch model: introduce long-lived `develop` branch
- Create `develop` from current `main` HEAD; push; set as default work-target
- All v1.4.20 feature/fix/test work commits to `develop`, NOT `main`
- `main` reserved for release-merges + tags + GHCR builds (no more daily image churn)
- Hotfixes branch from `main`, merge back to both `main` (with tag) and `develop` (sync)
- Update GHCR workflow if needed: builds trigger only on `main` push + tag, NOT on `develop`
- Memory: see `feedback_branch_model_dev_main.md`

### F2 — Document the branch + release model
- Add `CONTRIBUTING.md` at repo root: branch flow, PR conventions, release process
- Add small Mermaid or ASCII diagram of branch flow (develop → main → tag → deploy; hotfix from main → both)
- Add `docs/contributing.md` on the docs site mirroring the explanation for end-users / would-be contributors
- Make clear: end users follow `main` / latest tag (stable), contributors look at `develop`

### F3 — Repo-cleanup audit (retroactive)
- Multi-agent sweep across the repo for internal jargon leaking into user-facing artifacts:
  - `CHANGELOG.md`, `docs/audit/v*-summary.md`, `docs/`, `README.md`, healthlog-docs site, healthlog-landing site, anywhere `Phase X` / `Wave Y` / `marathon` / `sub-agent` / `autonomous orchestrator` / "Claude" name leaked
  - Replace with neutral language. Keep "Co-Authored-By: Claude Opus 4.7" trailer on commits (git-meta, not prose)
- Memory: see `feedback_marc_voice_english.md` v1.4.20 amendment
- Constraint: do NOT rewrite git history. Only edit current state of files.

### F4 — Release-notes language audit
- Marc spotted German strings leaking into English-only release notes
- Audit `CHANGELOG.md` + GitHub releases v1.4.14–v1.4.19 + docs/audit/v*-summary.md (where future ones still pending)
- Translate any German leaks to English

### F5 — Best-practice GitHub repo audit
- 2 parallel agents survey the repo structure
- Compare against best-practice OSS repos: README, LICENSE, CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md, .github/ISSUE_TEMPLATE, .github/PULL_REQUEST_TEMPLATE.md, GitHub badges, etc.
- Identify: files that don't belong, files missing, layout improvements
- Output: prioritized list, apply CRITICAL/HIGH inline, defer rest to v1.4.21

### F6 — Multi-agent QA on the new docs (no hallucinations)
- After F2 docs landed: separate agents read the dev-vs-prod docs and verify they describe the actual deployed state — no incorrect claims
- Flag anything inaccurate; fix before tagging

## v1.4.20 Insights redesign scope (after foundation done)

5 sequential phases per `.planning/phase-D-v1419-product-lead-review.md`:

- **B1** — Hero strip + Daily Briefing + Suggested-prompts (~3-5 days)
- **B2** — AI Coach panel + `/insights/coach` route + streaming chat + conversation persistence (~5-7 days, biggest)
- **B3** — Correlation discovery + Trends row with AI annotations (~3-5 days)
- **B4** — Weekly Report + Storyboard + Mobile passes (~3-4 days)
- **B5** — Personal AI Coach Health Score + "Ask the Coach" CTA (~2-3 days)

Plus: standard QA wave (5 reviewers + Product Lead), reconcile, release.

## Operational pattern (unchanged from v1.4.14–v1.4.19)

- Orchestrator-lite: dispatch sub-agents for each phase; orchestrator does minimal work itself
- Atomic commits per logical fix; pre-commit hooks must pass; no `--no-verify`
- Co-Author trailer on every commit (git-meta only)
- TDD throughout
- Multi-agent QA at the end of each release
- Marc-Brief at end (English, professional, Marc's voice, no Claude/Phase/marathon mentions)
- v1.4.20 work commits to `develop` — release-merge to `main` only at the end

## The trigger prompt

Paste this in the new session:

```
Lies und arbeite vollständig autonom ab: /Users/marc/Projects/HealthLog/.planning/v1420-marathon-handoff.md.

Start mit den Foundation-Tasks F1–F6 in Reihenfolge, danach v1.4.20-Marathon mit den 5 Phasen B1–B5 + QA + Release.

Standard-Pattern wie v1.4.14–v1.4.19: orchestrator-lite, parallele Sub-Agents, TDD, atomare Commits, Multi-Agent-QA + Product-Lead, Marc-Brief am Ende.

Alle Memories unter /Users/marc/.claude/projects/-Users-marc-Projects-HealthLog/memory/MEMORY.md gelten weiter. Englisch durchgängig, Marc's voice in user-facing artifacts, kein "Claude/Phase/marathon" in Release-Notes/Docs.

Speed wichtig — autonom über die Nacht / Tage. Bei Fragen: dispatchen statt fragen, dokumentieren statt blockieren.
```

## Notes for orchestrator at session start

1. **Before dispatching anything**, read this handoff doc + `.planning/STATE.md` + the user-memory MEMORY.md
2. Bootstrap a fresh `.planning/STATE.md` for v1.4.20 (replace v1.4.19 content with v1.4.20 scaffold; archive prior milestones to ROADMAP.md)
3. F1 (branch creation) is FAST — do it directly or via a small agent. Should take <5 min.
4. F2-F6 can largely run in parallel after F1 lands
5. ONLY after F1-F6 complete: dispatch v1.4.20 B1 (the Insights redesign Wave-B chain)
6. The Insights Wave is sequential B1 → B2 → B3 → B4 → B5 (each builds on prior)
7. After B5: standard Wave-D QA (6 parallel reviewers including Product Lead) → reconcile → Wave-E release
8. The release goes through the new branch model: feature work on `develop`, merge to `main` at release time, tag, GHCR build, Coolify deploy

## Don't lose

- The 4 deferred HIGH from v1.4.19 reconcile (in v1.4.20-backlog.md)
- The 31 MED + 16 LOW from A8 quality audit (also v1.4.20-backlog.md)
- The strategic items in product-lead-review (Coolify image-digest auto-deploy still pending, native ARM runner matrix, cross-user feedback prompt-tuning, etc.)
- The design handoff `~/Downloads/design_handoff_insights_redesign/` — re-read README.md at the start of each B-phase

## End state

When v1.4.20 ships:
- v1.4.20 live with the redesigned `/insights` + AI Coach
- `develop` branch established as the daily work-target
- CONTRIBUTING.md documents the model
- Repo cleaned of internal-jargon leaks
- `docs/audit/v1420-summary.md` written as Marc's morning brief
- Strategic v1.5 plan (iOS + Apple Health) updated based on what v1.4.20 learned
