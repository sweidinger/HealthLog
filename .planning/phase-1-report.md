# Phase 1 — Verify Codex-OAuth flow end-to-end

Status: **done**
Timestamp: 2026-05-09T15:50:00+02:00

## Summary

End-to-end verification of the ChatGPT-OAuth Codex integration on
production passed after one targeted fix to the default model slug.
v1.4.13 was deployed live and `/api/version=1.4.13` confirmed; the
device-start endpoint returns the correct spec-shaped payload; the
`/api/ai/test` endpoint and `/api/insights/generate` both succeed
end-to-end against Marc's ChatGPT-Plus subscription.

## v1.4.13 deploy

The two GHCR `docker-publish` runs that were in_progress at phase-0
(v1.4.13 tag + the bootstrap commit) both finished `success`. After
`mcp__coolify-apps01__deploy` queued the rollout, the host force-pull
recipe (`docker compose pull app && docker compose up -d app`) was
required to actually swap the image — the digest moved from the
12:36-built v1.4.12 image to the v1.4.13 image. `/api/version`
flipped from 1.4.12 to 1.4.13 once the new container was healthy.

## Codex flow probe

`POST /api/auth/codex/device-start` (with Marc's session cookie
`cmox4d6fj000101p8w9ykhcnm`) returned:

```
{ "userCode":"RUNZ-DIOCO",
  "verificationUrl":"https://auth.openai.com/codex/device",
  "intervalSeconds":5 }
```

— exact spec shape. Marc's `users.codex_connection_status` row was
already `connected` (token from 13:06 UTC, expiring 14:06 UTC), so the
poll path didn't need to be re-exercised. The device-poll connect
event from earlier today (logged as `codex.device.poll connected:true`)
was lost when the container restarted at 13:23, but the DB row proves
it landed.

## Root cause + fix

`/api/ai/test` against the v1.4.13 image returned `Provider connection
failed`; the `ai_test_body_excerpt` annotation captured the upstream
error verbatim:

```
{"detail":"The 'gpt-5' model is not supported when using Codex with a
ChatGPT account."}
```

v1.4.13 had switched the default from the rejected `gpt-5-codex` to
the equally-rejected plain `gpt-5`. Cross-checking
`codex-rs/models-manager/models.json` in `openai/codex` showed the
current bundled Codex slugs are `gpt-5.5 / gpt-5.4 / gpt-5.4-mini /
gpt-5.3-codex / gpt-5.2` — neither `gpt-5` nor `gpt-5-codex` is in the
allow-list. `gpt-5.3-codex` is the codex-optimised slug whose
`available_in_plans` includes `plus` (Marc's tier).

Setting `CODEX_MODEL=gpt-5.3-codex` via Coolify env var + restart
made `/api/ai/test` succeed: `{"ok":true,"providerType":"codex",
"model":"gpt-5.3-codex","tokensUsed":40,"sample":"{\"ok\": true}"}`.
`/api/insights/generate` also produced a real summary against Marc's
data. Commit `5df74f7` flipped the in-code default to `gpt-5.3-codex`
and updated `docs/codex-protocol-spec.md` §7a with the
chatgpt-account-auth allow-list constraint and the lesson that the
slugs in `model_migration.rs` are migration _prompts_, not wire slugs.

## Screenshot

`/tmp/v15-codex-working.png` shows `/settings/ai` with the green
"ChatGPT connected" badge, "Connected since 05/09/2026, 15:06" line,
and a "Last generated: 05/09/2026, 15:45" timestamp matching the
successful test.

## Open

The model-slug fix is on `main` (commit `5df74f7`); GHCR build was
in_progress when this report was written. The `CODEX_MODEL=gpt-5.3-codex`
env var remains set on apps-01 as a safety net during the rollout
window — once `5df74f7` lands as `:latest` on prod the env var becomes
redundant but harmless (operators on different plan tiers may still
want to override). Phase 2 picks up here.
