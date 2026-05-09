# v1.4.15 Phase D — Security Review Findings

Reviewer: phase-D security agent
Scope: v1.4.15 diff against v1.4.14 (`git log v1.4.14..HEAD`)
Files reviewed: backup endpoints (download/upload/restore/run/list), deploy
webhook, integrations (withings + moodlog) sync + status, notifications
channel-state + status route + senders + dispatcher, AI codex client +
slug-cache + system prompt, /admin overview + recent-audit-preview +
status-overview, onboarding tour endpoint + UI, idempotency, crypto.

## Summary

- **0 CRITICAL** ship-blockers
- **0 HIGH**
- **8 MEDIUM/LOW**

The v1.4.15 surface is solidly hardened. Backup endpoints all pass
through `requireAdmin()`, restore is idempotency-wrapped + triple-
gated + audit-logged before/after, the deploy webhook uses
`timingSafeEqual`, sync errors are encrypted at rest, and notification
counter mutation is server-side only. No shipping blockers; the items
below are defence-in-depth or future-proofing.

---

## MEDIUM

### M1 — Restore transaction is not bounded by an interactive-query timeout
- **Severity**: MEDIUM
- **File:Line**: `src/app/api/admin/backups/[id]/restore/route.ts:253-377`
- **Issue**: The restore wraps deletes + creates in a single
  `prisma.$transaction(async (tx) => …)` with no `maxWait` / `timeout`
  override. Prisma's default 5s tx timeout will trip the moment a user
  has > ~10k intake events on a slow disk, leaving the user's data
  partially deleted (delete completes inside the same tx, but if
  `createMany` exceeds the timeout the rollback fires). The
  `admin.backups.restore.failed` audit row records the exception, but
  the operator only learns about the half-state from the next page-load
  showing zero medications and zero intake events, then has to manually
  re-run restore.
- **Recommendation**: Pass `{ timeout: 30_000, maxWait: 5_000 }` (or a
  config-driven knob) to `prisma.$transaction()`. Empirically a 5–15
  MB backup completes in under a second; 30s is generous headroom.
  Alternative: split the transaction into delete-tx + create-tx with
  the audit log capturing the in-between state, but that's a bigger
  rewrite; the timeout fix is the minimum viable hardening.
- **Ship-blocker?** No

### M2 — Restored backup's `data` blob is re-encryptable but the upload route does not enforce key version
- **Severity**: MEDIUM
- **File:Line**: `src/app/api/admin/backups/upload/route.ts:193`,
  `src/lib/crypto.ts:199`
- **Issue**: `encrypt(JSON.stringify(payload))` writes with the active
  key id. Good. But: no audit-log annotation captures which key id was
  used. After a future `ENCRYPTION_ACTIVE_KEY_ID` rotation, an admin
  inspecting "why does this old MANUAL_UPLOAD blob fail to decrypt
  today" has no audit trail telling them which key is needed. Same
  story for the `WEEKLY_AUTO` writes from the worker.
- **Recommendation**: In the audit-log `details` for
  `admin.backups.upload`, include `extractKeyId(encrypted)` so the
  forensic trail can correlate a key-rotation incident to specific
  backup rows. (Pure observability — not a security boundary fix.)
- **Ship-blocker?** No

### M3 — Slug cache is process-global; same Map shared across users on multi-tenant deploys
- **Severity**: LOW (informational — caller asked to verify)
- **File:Line**: `src/lib/ai/codex-slug-cache.ts:32-34`
- **Issue**: The cache key is the literal string `"codex"` — a single
  global slot. Verified per the spec; no per-user data lives in the
  cache (just an upstream-public slug like `"gpt-5.3-codex"`). No leak
  concern. However: in a multi-tenant deploy where users supply their
  own ChatGPT account, a slug accepted on user-A's account is
  optimistically tried on user-B's account. Worst case: one extra
  failed request before the chain walks. Not a security issue, but
  worth recording.
- **Recommendation**: Document explicitly that the cache is global by
  design, with a future hook (the comment at lines 31-33 already
  hints) to scope by `accountId`. Add a Wide Event annotation when
  cache is invalidated due to a slug rejection so a flapping account
  is visible without user-attribution.
- **Ship-blocker?** No

### M4 — `/api/admin/audit-log` returns full `details` JSON to any admin
- **Severity**: MEDIUM
- **File:Line**: `src/app/api/admin/audit-log/route.ts:34-53`
- **Issue**: The `details` column is selected unfiltered. Some action
  rows now carry payloads written by the new v1.4.15 code:
  `integrations.sync.failed` includes the raw `message` string from
  upstream errors (lines 225-235 of `src/lib/integrations/status.ts`),
  and `system.deploy.unknown` keeps the **entire raw Coolify payload**
  (`raw: event.raw` at `src/app/api/internal/deploy-webhook/route.ts:199`).
  In a single-tenant deploy this is fine because every admin already
  has read-everything authority. In a future multi-tenant scenario,
  admins of tenant-A could see deploy-status payloads that may carry
  hostnames, deployment UUIDs, or upstream error text from tenant-B.
  Today this is a non-issue (single admin, single tenant) but the
  surface is wider than the new `<RecentAuditPreview>` shows.
- **Recommendation**: Document the assumption ("admin.audit-log returns
  cross-tenant details — must be tightened before any multi-tenant
  release"). Flag for v1.5 when multi-tenant lands.
- **Ship-blocker?** No

### M5 — Test-send rate limits diverge across notification surfaces
- **Severity**: LOW
- **File:Line**:
  - `src/app/api/settings/telegram/test/route.ts:15` — 5/5min
  - `src/app/api/settings/ntfy/test/route.ts:16` — 5/5min
  - `src/app/api/admin/notifications/test/route.ts` — **no rate limit**
- **Issue**: `POST /api/admin/notifications/test` sends a SYSTEM_ALERT
  through every enabled channel for the admin. It's `requireAdmin()`-
  gated but has no per-actor rate limit. A compromised admin session
  could spam Telegram/ntfy/web-push as fast as the upstream allows,
  burning quota and inviting upstream rate-limit penalties (Telegram's
  bot endpoint rate-limits aggressively and a 429 here would also
  affect legitimate medication-reminder traffic).
- **Recommendation**: Add `checkRateLimit('admin-notifications-test:'
  + admin.id, 5, 5 * 60_000)` mirroring the user-side handlers.
- **Ship-blocker?** No

### M6 — Backup download `Content-Disposition` filename uses the unescaped userId
- **Severity**: LOW
- **File:Line**: `src/app/api/admin/backups/[id]/download/route.ts:92-114`
- **Issue**: `filename="healthlog-backup-${backup.userId}-${isoDate}.json"`
  is interpolated unescaped. UserIds are cuid/cuid2 (alphanumeric +
  `_-`) so no quoting attack is realistic against the current ID
  format, BUT the surface depends entirely on the ID generator never
  emitting a `"` or newline. If a future schema change ever swaps
  cuid2 for a UUID-with-format-error or a custom value, the unescaped
  interpolation becomes a header-injection vector.
- **Recommendation**: Use `RFC 5987` `filename*=UTF-8''<percent-encoded>`
  or simply `filename="healthlog-backup-<isoDate>.json"` (no userId in
  the filename — the contents already carry it).
- **Ship-blocker?** No

### M7 — Restore does NOT clear `IntegrationStatus`, `WithingsConnection`, encrypted credentials
- **Severity**: MEDIUM
- **File:Line**: `src/app/api/admin/backups/[id]/restore/route.ts:259-279`
- **Issue**: The transaction deletes measurements, medications, intake
  events, mood entries, notification channels, push subscriptions,
  telegram-scheduled-deletions. But it does NOT clear: the user's
  `WithingsConnection` (encrypted access/refresh tokens at rest),
  `IntegrationStatus` rows, the user's `moodLogApiKeyEncrypted` /
  `moodLogUrlEncrypted`, OR Telegram credentials on the User row.
  Result: after a restore from a snapshot taken pre-Withings-connect,
  the user's old Withings tokens still work — they're "leaking through"
  the restore. For a single-user Marc instance this is irrelevant; for
  a future multi-user instance where a user requests a "wipe-and-
  restore-to-this-snapshot" workflow, the implicit assumption that
  restore == clean state is violated.
- **Recommendation**: Either (a) document explicitly in the restore
  endpoint and admin UI that integrations + auth credentials persist
  through restore (current behaviour, may be desired for "don't wipe
  my Withings link"), or (b) extend the delete scope to mirror
  `DELETE /api/admin/data` exactly. Pick one and document.
- **Ship-blocker?** No

### M8 — Deploy webhook 401 path leaks "secret configured" via warning side-channel (low impact)
- **Severity**: LOW
- **File:Line**: `src/app/api/internal/deploy-webhook/route.ts:84-96`
- **Issue**: `hasValidSecret()` returns `false` when the env secret is
  unset, with side-effect `addWarning("DEPLOY_WEBHOOK_SECRET not
  configured")`. The HTTP response is 401 in both "secret unset" and
  "secret wrong" cases — no user-observable leak. But the
  Wide-Event/Loki annotation distinguishes them. If an attacker has
  read access to logs (out-of-scope by definition), they can probe
  whether the deploy webhook is configured. This is observable but
  not exploitable — included only because the caller explicitly asked
  about presence-of-secret leakage.
- **Recommendation**: Acceptable. The warning is useful for ops triage
  ("why isn't deploy paging me — did I forget to set the env?"). No
  change needed; documented for completeness.
- **Ship-blocker?** No

---

## Verified Safe (no findings)

- **B1 backup endpoints** — every endpoint passes through `requireAdmin()`
  (cookie-only). Restore: triple-confirm (`confirm: "RESTORE"`),
  idempotency-wrapped via `withIdempotency`, transaction atomicity,
  before+during+after audit logs (`admin.backups.restore.start` /
  `.failed` / final `admin.backups.restore`). Upload: 10 MB cap on
  both `Content-Length` AND `file.size`, `Content-Type` arrives as
  multipart/form-data, schema validation rejects malformed AND
  version-incompat (`isCompatibleSchemaVersion`), 3/min rate limit.
  Restored backups encrypted with same AES-256-GCM via `crypto.ts`
  (verified `encrypt(JSON.stringify(payload))` at upload route line
  193).

- **C2 deploy webhook HMAC verification** — uses
  `crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received))`
  with explicit length-equality precheck (lines 92-95). No raw
  string-compare. Rate limit by IP at 60/min (line 151) so a brute-
  force isn't economically viable. Validation ordering: rate-limit →
  auth-check → JSON parse → audit-log + dispatch. Secret never logged
  (`redactSecrets` would catch a `Bearer` accidentally written to an
  error message; the `getClientIp` and audit annotations in this
  route never include the secret value).

- **B2 sync robustness** — Withings + moodLog tokens encrypted at
  rest via `crypto.encrypt()`. Refresh-token race: each
  `getValidToken()` call reads the connection row, compares
  `tokenExpiresAt - 5min < Date.now()`, refreshes serially, and
  writes back via `prisma.update`. The 5-minute buffer is the same
  for parallel requests, so two concurrent requests COULD both
  attempt a refresh — but the second request will get an
  `invalid_grant` (Withings consumes the refresh token on first use)
  and route via `recordSyncFailure` to `error_reauth`. Acceptable
  because the failure is captured + audit-logged; the alternative
  (DB advisory lock) is over-engineered for a once-per-30min job.
  "Reauth required" state can't leak old tokens — token columns are
  preserved encrypted, but `getValidToken` returns null on reauth so
  no decrypt path runs. The `markReauthRequired` audit-log details
  do NOT include any token material (verified at status.ts line
  302).

- **B3 notification reliability** — counter manipulation: all
  consecutiveFailures mutations (`channel-state.ts:90, 102, 138`)
  happen server-side from dispatcher outcomes; no user-facing API
  accepts or modifies the count. Re-enable button: `POST
  /api/notifications/status` is `requireAuth()`-gated AND the
  `findFirst` query scopes by `userId: user.id` so one user can't
  re-enable another user's channel (line 108-111). Test-send: rate-
  limited on `/settings/{telegram,ntfy}/test` at 5/5min; admin test
  endpoint missing rate limit (see M5).

- **C1 AI hardening** — system prompt + user data: the user data
  passed in `params.userPrompt` is the snapshot JSON the route layer
  built from the user's OWN measurements, not free-form user input.
  Prompt-injection from a user manipulating their own snapshot is a
  hallucination concern (the strict prompt at
  `prompts/insight-generator.ts:53-72` enforces "ground in numbers,
  refuse out-of-scope") but not a cross-user data exposure. The
  fallback-chain cache is global (M3) but holds only the public slug
  string — no PII. Citations in the response cite only fields from
  the user's own snapshot (`metricSource.type` references like
  `bloodPressure`, `weight`); no cross-user data path exists.

- **A2 /admin overview** — `RecentAuditPreview` fetches via
  `/api/admin/audit-log`, which is `requireAdmin()`-gated. No URL-
  guessing path lands a non-admin on the audit data (handler returns
  401 before query). System-status snapshot: surfaces `version`,
  `database` connection state, `worker.running`, `gitCommit`,
  `builtAt` — nothing infrastructural an external observer can't
  derive from `/api/version` (which is public). Not a leak.

- **B5 onboarding tour overlay** — `OnboardingTour` renders as
  `position: fixed; z-[200]` ABOVE the dashboard but its content is
  app-controlled (i18n keys, no user-supplied strings). Backdrop
  click-through is dismissive (Skip), not silent. Tooltip body is
  rendered via `{t(stop.bodyKey)}` (React-text, escaped — not
  `dangerouslySetInnerHTML`). No phishing-mask vector unless an
  attacker can write to `messages/*.json`, which is part of the
  build artifact, not user-supplied.

- **General checks**:
  - `dangerouslySetInnerHTML`: only one occurrence in the entire
    `src/` tree — `src/app/layout.tsx:93` for the inline theme-
    bootstrap script. Content is the static `themeScript` constant,
    not i18n.
  - All new API routes wrap in `apiHandler()` (verified in
    backups/run, backups/[id]/download, backups/[id]/restore,
    backups/upload, internal/deploy-webhook, integrations/status,
    notifications/status, onboarding/tour).
  - New logging respects `redactSecrets` — `redact.ts` catches
    `Bearer`, `bot<digits>:<token>`, `sk-`/`sk-ant-`, `hlk_`/`hlr_`,
    `?secret=`/`?code=`/`?token=`/`?api[_-]?key=`. The Codex
    client's local `redactBody` at `codex-client.ts:470` covers the
    same surface for upstream-error bodies that don't pass through
    the WideEvent error path.
  - No `console.log` in production code paths beyond
    `instrumentation.ts` (Glitchtip init), `crypto.ts` (dev-only
    key-padding warning), `reminder-worker.ts` (pg-boss adapter for
    library-level errors).

---

## Verdict

**No CRITICAL or HIGH ship-blockers.** v1.4.15 can ship. The 8 medium/
low items are defence-in-depth recommendations for v1.4.16+; M1
(transaction timeout) and M5 (admin test-send rate limit) are the
two most worth folding in before a multi-user deploy.
