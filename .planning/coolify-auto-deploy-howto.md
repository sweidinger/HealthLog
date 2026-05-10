# Coolify image-digest auto-deploy — minimal maintainer action

Status: maintainer-task — the toggle lives in Coolify's UI; neither the
Coolify MCP nor the GitHub workflow can flip it.

## The problem

Releases v1.4.19, v1.4.20, and v1.4.21 all required a host-side `docker
tag <sha> :latest` + `docker compose up -d --no-deps` fallback after
GHCR pushed the new image. Coolify pulled `:latest` from its local
cache without re-checking the GHCR registry digest, so the freshly
published image never reached production until the maintainer SSH'd
into the host and forced the retag.

Longer history: `docs/audit/v1416-auto-deploy-fix.md` documents the
v1.4.15 partial fix (workflow-side webhook trigger) and why it
half-solved the problem.

## The minimal change

In the Coolify UI for the HealthLog application:

1. Open **Configuration → Source** (or equivalent tab depending on the
   Coolify version — the option may also live under "General" or
   "Deploy").
2. Enable the **"Watch image registry for new digests"** /
   **"Image-digest auto-deploy"** checkbox. Coolify v4 names it
   slightly differently across point-releases; the one that triggers a
   pull when the registry digest changes (not when a git push lands)
   is the one we want.
3. Save. The next time GHCR pushes a new `:latest` digest, Coolify
   will pull and recreate the container without a host-side retag.

## Why not solve it in the workflow

Two non-options were ruled out:

- **Push the explicit version tag in `docker-compose.yml`** — would
  require a workflow edit on every release to bump `image:` to the new
  tag. Worse than the current state (a manual host-side step) because
  the release author has to remember the second commit.
- **Pre-deployment `docker pull` hook in the Coolify app config** —
  duplicates what the registry-digest auto-deploy already does, but
  worse: the pull runs on every deploy trigger (including doc-only
  pushes) instead of only when the digest changed.

The workflow file (`.github/workflows/docker-publish.yml`) already
pings Coolify's webhook with `?force=true` after the GHCR push, so the
trigger half of the contract is in place — the missing half is the
registry-digest check, which is a Coolify-side feature.

## Verification

Push a new release tag. The expected sequence is:

1. `docker-publish.yml` builds, signs, pushes to GHCR.
2. Coolify webhook fires; Coolify pulls the new digest because
   "Watch image registry" is enabled.
3. `https://healthlog.bombeck.io/api/version` returns the new version
   string within ~60s of the GHCR push — without SSH.

If step 3 still requires a host-side retag, the checkbox is in the
wrong place in the UI for that Coolify version — open the audit doc
above and the v1.5 deferral note for the alternative
(GHCR-tag-promoted-by-workflow path).
