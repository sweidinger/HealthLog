# Phase F1 — Long-lived `develop` branch

Status: complete · 2026-05-10T15:25+02:00

## Outcome

`develop` branch created from cleaned `main` HEAD (`a1cf9bc`) and
pushed to `origin/develop` with upstream tracking. Both branches now
point at the same commit; they will diverge as v1.4.20 work commits
to `develop` only.

## GHCR workflow audit

`/Users/marc/Projects/HealthLog/.github/workflows/docker-publish.yml`
already had the right shape:

```yaml
on:
  push:
    branches: [main]
    tags: ["v*"]
  pull_request:
    branches: [main]
  workflow_dispatch:
```

- Push to `main` → image build + push to GHCR + Coolify webhook
- Push to a `v*` tag → image build + push (`{{version}}` + `{{major.minor}}` tags)
- PR targeting `main` → build only, no push (so PR builds don't pollute `:latest`)
- Push to `develop` → no trigger
- Push to any other branch → no trigger

No workflow change needed. Develop pushes are silent, exactly as
intended for the daily-work branch.

## Branch model contract (enforced from F1 onward)

- All v1.4.20 feature/fix/test work commits to `develop`
- Hotfixes branch from `main`, merge back to both (`main` with tag, `develop` to sync)
- Release-merge `develop` → `main` happens at Phase E only; `main` carries the tag, GHCR builds, Coolify deploys
- `main` is no longer the daily image-churn target

## Memory updated

`feedback_branch_model_dev_main.md` already captured this; the
session's STATE.md F1 block + the new `CONTRIBUTING.md` (F2) make it
visible to contributors.
