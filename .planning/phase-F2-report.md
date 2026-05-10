# Phase F2 — Document branch + release model

Status: complete · 2026-05-10T15:18+02:00

## Outcome

The two-branch model is documented in two places:

| Surface | File | Audience |
|---|---|---|
| Repo root | `CONTRIBUTING.md` (extended) | Contributors cloning the repo |
| Docs site | `src/content/docs/contributing/branch-model.mdx` | End users + would-be contributors browsing docs.healthlog.dev |

Both contain:

- ASCII branch-flow diagram (`feature/* → develop → main → tag → GHCR → Coolify`)
- Two-rule summary (develop = daily, main = release-only)
- Hotfix flow (branch from main, tag patch, merge back to develop)
- Explicit "end users follow tags / contributors track develop" guidance

## Commits

| Repo | Commit | Branch |
|---|---|---|
| HealthLog | (this commit) | `develop` |
| healthlog-docs | `5d96861` | `main` |

## Build verification

`healthlog-docs`: `npm run build` green, 46 pages built (was 45),
new `/contributing/branch-model/` slug rendered, pagefind search
index covers it.

## Why this lands now (before B-phase work)

The branch model is operational: every B1-B5 commit goes to `develop`.
If the docs lag behind the operational reality, would-be contributors
who clone the repo today and open a PR against `main` would need to
re-target it. Docs ship with F2 so that contract is clear from the
first v1.4.20 commit.

## Sidebar placement

The new "Contributing" sidebar group sits at the bottom of the docs
nav, below "Account". Contains one entry today (`branch-model`); F5
or future hygiene PRs may add `code-conventions`,
`dev-environment`, etc.
