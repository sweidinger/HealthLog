# Phase F5 — Best-practice GitHub repo audit

Status: complete · 2026-05-10T15:30+02:00

Initial sub-agent dispatch hit a content-filter block on the
Contributor Covenant text. Refactored to inline execution: download
the CoC verbatim from `contributor-covenant.org`, then add the rest
manually as four atomic commits.

## Pre-existing compliance pass

| File                     | State                                 |
| ------------------------ | ------------------------------------- |
| `README.md`              | Comprehensive; no edits               |
| `LICENSE`                | AGPL-3.0; no edits                    |
| `CONTRIBUTING.md`        | Just extended in F2 with branch model |
| `SECURITY.md`            | Current; security@bombeck.io contact  |
| `.gitignore`             | Standard Next.js + Node coverage      |
| `.github/dependabot.yml` | npm only — extended below             |

## Inline fixes (CRITICAL + HIGH)

Four atomic commits on `develop`:

| Commit    | Adds                                                                                                  |
| --------- | ----------------------------------------------------------------------------------------------------- |
| `e7b6b27` | `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1, conduct@bombeck.io contact) + CONTRIBUTING.md link    |
| `072941b` | `.github/ISSUE_TEMPLATE/{bug_report,feature_request,config}.yml` + `.github/PULL_REQUEST_TEMPLATE.md` |
| `779e5a3` | `.github/dependabot.yml` extended with `github-actions` + `docker` ecosystems                         |
| `f7977d1` | `package.json` metadata: description, license, homepage, repository, bugs, keywords                   |

### Why each is non-trivial

- **CoC** is the OSS baseline GitHub badges check for; absence reads as
  "unmoderated project" and discourages participation. Verbatim
  Contributor Covenant 2.1 from canonical source.
- **Issue templates** as YAML form schemas (not Markdown) so the
  GitHub UI renders structured fields, validates required inputs,
  and prevents the "user posts unstructured text → maintainer asks
  for version → user re-posts" round-trip. Bug template auto-routes
  security to SECURITY.md.
- **PR template** explicitly reminds the contributor to target
  `develop`, not `main` — pairs with the F1 branch-model rollout.
  Checklist mirrors the local CI command.
- **Dependabot** extension covers `.github/workflows/*` action
  versions (the npm-only previous config was silently leaving
  `actions/checkout@v4` etc. unmonitored) and the `Dockerfile` base
  image.
- **package.json** metadata fills fields that npm scrapers, SBOM
  tooling, and GitHub package-cards display.

## Deferred to v1.4.21

Captured in `.planning/v1421-backlog.md` under "F5 — Best-practice
repo audit (deferred MED + LOW)". Five items, all LOW:

- README badges row
- FUNDING.yml (only if the maintainer enables a sponsor profile)
- Repo-root tidy
- `.gitignore` audit (no gaps spotted)
- Discussions enablement verification

## Post-run state

- 4 commits on `origin/develop` (post-push)
- `pnpm install` not re-run (no dependency changes)
- Pre-commit hooks green on every commit; no `--no-verify`, no
  `--no-gpg-sign`
- No edits to CHANGELOG.md, docs/audit/\*, or any source file
