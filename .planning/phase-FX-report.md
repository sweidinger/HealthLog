# Phase FX — User-facing artifact cleanup

Status: complete · 2026-05-10T15:15+02:00

Combined wave covering the original F3 (jargon sweep), F4 (German
leaks), and a new PII rule the maintainer flagged after seeing v1.4.19
release notes leak personal name + health figures.

## Three repos, three commits

| Repo | Commit | Files | Diff |
|---|---|---|---|
| HealthLog (main repo) | `a1cf9bc` on `origin/main` | 20 | +265 / −269 |
| healthlog-docs | `782862b` on `origin/main` | 7 | API examples + DE leaks |
| healthlog-landing | `9b31083` on `origin/main` | 1 | JSON-LD author block |

Three parallel sub-agents executed the scrubs simultaneously; commits
landed independently. No working-tree races. No `--no-verify`. No
`--no-gpg-sign`. Pre-commit hooks green on every push.

## Scope

Removed from user-facing artifacts (CHANGELOG, GH-release-targeted
summaries, public docs site, public landing copy):

- Maintainer's real name (replaced with neutral framing or
  "the maintainer" / "the live tenant" / "an authenticated session")
- Specific health figures tied to the live tenant (BP-target
  percentages, paired-reading counts, weight loss numbers, mood
  scores)
- Internal release-process jargon (Phase X / Wave Y / marathon /
  sub-agent / orchestrator / "Marc-Brief" headings)
- Stray German strings in English-only release notes

## Preserved (not leaks)

- "Phase-Based Reminders" — real product feature for medication
  reminder escalation (green/yellow/orange/red)
- "Anthropic Claude" / `claude-3-5-haiku` — third-party product +
  model slugs in the AI provider feature copy
- Public canonical URLs (`bombeck.io`, `MBombeck/HealthLog`,
  `mbombeck/healthlog`) — these are how users find the project
- `Co-Authored-By: Claude Opus 4.7` git trailer — git-meta only,
  not visible in any rendered surface
- `sub-agent` in `docs/codex-protocol-spec.md` — literal upstream
  Codex protocol header names (`x-openai-subagent`)
- "Datengrundlage ist sehr stark" in `ai-insights.mdx` — documents
  the forbidden phrase the prompt blocks (load-bearing for the
  feature explanation)

## Carried over to v1.4.21 backlog

- Source-comment sweep: `src/` has 191 `Marc` references in
  maintainer-internal comments. Visible to anyone who clones the
  repo. Lower priority because these are not "rendered" artifacts;
  schedule for v1.4.21 hygiene pass.
- DE+EN bilingual CHANGELOG entries (v1.4.15 era only) — each entry
  pairs a German sentence with its English translation by historical
  design. Translating them out is a larger rewrite.
- `CLAUDE.md` + `AGENTS.md` filenames at repo root — visible in any
  directory listing. Renaming is a structural change with downstream
  links; defer until a hygiene PR.

## Pre-release PII gate

Phase E for v1.4.20 will add a release-pipeline grep gate:

```bash
git grep -niE 'Marc[^a-z]|Marc-Brief|Marc-side|all-time ≈|572 paired' \
  CHANGELOG.md docs/audit/ docs/ README.md SECURITY.md public/ && exit 1
```

If the grep returns any hit, tag is blocked until the leak is
resolved. Captured in `STATE.md` Phase E checklist.

## GH releases

The published v1.4.14–v1.4.19 GitHub release bodies still carry the
old leak. Republish from cleaned CHANGELOG sections during Phase E for
v1.4.20 — captured in the Phase E task list.
