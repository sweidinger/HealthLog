# v1.4.19 phase-D — Security Review Findings

Reviewer: phase-D security
Date: 2026-05-09
Scope: 49 commits between v1.4.18 and HEAD (Wave A1-A7 + Wave B 27 fixes).
Method: Read CLAUDE.md, .planning/STATE.md, full diff via
`git log --oneline v1.4.18...HEAD` + targeted `git diff` per file,
plus reads of every changed source file in the focus list, plus
cross-checks of:
  - the prompt revision against the existing server-side n<3
    confidence clamp (`src/lib/ai/confidence.ts`)
  - the integration error decryption path (unchanged from v1.4.18)
  - the admin tokens API selector (no `tokenHash`)
  - new audit-log labels' semantics
  - i18n placeholder interpolation (`{count}`, integer-only)

(Previous v1.4.18 review at `phase-D-v1418-security-findings.md` was
overwritten — the v1.4.18 release shipped, those findings already
filed in `.planning/v1419-backlog.md` / `.planning/v15-backlog.md`.)

## Verdict

**0 CRITICAL. 0 HIGH. 3 MED/LOW. No ship-blockers.**

---

## CRITICAL — none

---

## HIGH — none

---

## MED / LOW

### MED-1 — Recent-audit-preview row exposes IP address inline (admin-only)

- **Severity**: MED (existing data, new visible surface, admin-only)
- **File**: `src/components/admin/recent-audit-preview.tsx:144-148`
- **Issue**: Wave B / F-31 wraps each audit row in a `<Link>` to the
  full login-overview viewer AND adds a new visible column showing
  `entry.ipAddress` on `>=sm` viewports. The data was already part of
  the `AdminAuditEntry` payload (`/api/admin/audit-log` already
  returns `ipAddress` — see `src/components/admin/_shared.tsx:88`),
  and the parent route is gated by `user.role !== "ADMIN"` server
  guard in `src/app/admin/page.tsx:27`. So no privilege escalation,
  no new data exposed to a new audience.
  Attack scenario considered: a non-admin opening the dashboard
  preview card and reading other users' IPs — does NOT apply, the
  parent route refuses non-admins server-side via the same admin-page
  guard the rest of the section uses. The IP was already visible on
  `/admin/audit-log` and `/admin/login-overview`.
- **Recommendation**: No code change required. Worth noting in the
  release brief that admins now see IP addresses on the dashboard
  preview, not just the deep audit-log view.
- **Ship-blocker**: No.

### LOW-1 — A4 prompt's n<7 caveat threshold differs from server-side n<3 clamp

- **Severity**: LOW
- **File**: `src/lib/ai/prompts/insight-generator.ts:86-95` (EN),
  `:219-229` (DE)
- **Issue**: GROUND RULE 7 tells the model to mention data quality
  only when `n<7`, `recencyDays>14`, or coverage gap. The
  server-side `computeConfidence` (`src/lib/ai/confidence.ts:73-75`,
  untouched in v1.4.19) hard-caps confidence at `5*n` for `n<3`.
  Different thresholds — orthogonal but worth noting.
  - **Marc's specific concern (responding confidently on n=2)**:
    MITIGATED. At n=2 the prompt requires a caveat (2<7) AND the
    server-side `computeConfidence` clamps at `max(10, 5*2)=10/100`.
    Both gates fire. The user-visible pill renders n=2 as
    "low-confidence draft" regardless of model wording.
  - The diff is **purely additive** (verified line-by-line):
    GROUND RULE 7 is appended after rules 1-6. None of the existing
    rules ("no claim without snapshot field" / "no recommendation
    without metricSource" / "every metricSource cited" / etc.) are
    removed or weakened.
  - For n=3..6 the prompt allows the model to skip a caveat.
    Server-side confidence at n=3..6 is in the 30-40 range from the
    saturating curve before recency/signal bonuses, which the UI
    pill still surfaces as a moderate-confidence value. So the
    safeguard at this band is the confidence pill, not a forced
    summary caveat. This is consistent with the design intent of
    A4 (Marc explicitly didn't want the filler "Datengrundlage ist
    sehr stark" sentence).
  - PROMPT_VERSION bumped 4.16.1 → 4.19.0; cached pre-v1.4.19
    payloads remain attributable via the row's `promptVersion`
    column for analytics/feedback aggregation.
- **Recommendation**: None now. If feedback shows the n<7 sentinel
  is too generous (e.g. n=4 yielding uncaveat'd recommendations
  users flag as overconfident), tighten the prompt's caveat trigger
  to match the server's `n<3` clamp in v1.4.20.
- **Ship-blocker**: No.

### LOW-2 — Status pill shows decrypted last-error string from integration backend

- **Severity**: LOW (existing v1.4.18 behaviour, surfaced by A5 refactor)
- **File**: `src/components/settings/integrations-section.tsx:332-333,
  354, 630-631, 663` (`<IntegrationErrorMessage>`)
- **Issue**: A5 consolidated the status UI but kept the inline
  actionable error message under the pill. `viewModel.lastError` is
  decrypted by the API in `src/lib/integrations/status.ts:112,
  376-383` from the `IntegrationStatus.lastError` ciphertext. The
  message is bounded to 1024 chars at encrypt time
  (`status.ts:367`) and originates from controlled callsites in
  `src/lib/withings/sync.ts` + `src/lib/moodlog/sync.ts` — neither
  diff touched in v1.4.19.
  - The pill ITSELF leaks nothing — it shows a literal status
    label ("Connected" / "Error — reconnect" / "Not connected"), an
    aria-label ("Integration status"), and a relative-time suffix
    derived from `lastSyncedAt`. No URL, no IP, no token.
  - The error MESSAGE under the pill could in principle contain a
    Withings or moodLog API URL if a future caller passes a fetch
    error.message verbatim, but every callsite I read passes
    structured OAuth-error codes (`invalid_grant`), bounded
    fetch-error.message strings, or hand-constructed text — never
    a token, never an Authorization header. Withings/moodLog OAuth
    error responses do not contain refresh tokens.
  - Pill viewer is the message owner only — `/api/integrations/
    status` is `requireAuth`-gated and returns the calling user's
    own row.
- **Recommendation**: None for v1.4.19. If a future v1.5 sync
  helper passes raw HTTP body into `recordSyncFailure`, that's the
  place to whitelist the message before encryption.
- **Ship-blocker**: No.

---

## Verified non-issues (focus-area answers)

### Q1 — A4 prompt revision lowers data-quality refusal threshold?

**No.** The change is purely additive (GROUND RULE 7). Existing
rules 1-6 (no claim without snapshot field, no recommendation without
metricSource, every metricSource cited in citations[], cite user
baseline before population norms, rationale.dataWindow ===
metricSource.timeRange, narrate comparison-mode block) are all
preserved verbatim.

The server-side `n<3` confidence clamp in
`src/lib/ai/confidence.ts:73-75` (`Math.max(10, 5 * n)`) is
**untouched**. For n=2 the recommendation caps at confidence
10/100 regardless of what the model claims. Even a confident-sounding
recommendation at n=2 renders as low-confidence in the UI pill.

PROMPT_VERSION bumped 4.16.1 → 4.19.0; cached pre-A4 payloads
remain attributable via the cache row's `promptVersion` column.

See LOW-1 for the n<7 vs n<3 threshold note.

### Q2 — A5 status pill leaks IP/endpoint/token info?

**No.** The pill renders three strings only: a status label
("Connected" / "Error — reconnect" / "Not connected"), an aria-label
("Integration status"), and a relative-time suffix derived from
`lastSyncedAt` (max specificity: "X d ago"). No URL, no IP, no
token, no error text.

The inline error message under the pill is unchanged from v1.4.18
behaviour and bounded to 1024 chars from controlled callsites; see
LOW-2 above.

### Q3 — A6 input-height changes affect password-input masking?

**No.** Verified empty `git diff` for
`src/components/settings/password-input.tsx` and
`src/components/ui/input.tsx`. A6's height-equalisation work is
purely Tailwind class swaps on `<select>` / button trigger elements
(`h-10 → h-9`, `h-8 → h-9`, `min-h-11` removal). It does not touch
`<PasswordInput>`'s `type` attribute swap, the eye-toggle button,
or any masking logic.

### Q4 — A7 feedback scrollbar fix drops scroll-confinement that
prevents action-overflow?

**No.** `src/components/ui/tabs.tsx` adds `overflow-y-hidden` and a
`group-data-[orientation=vertical]/tabs:overflow-y-visible` reset.
Horizontal `overflow-x-auto` and `touch-pan-x` are preserved. So
horizontal swipe / scroll on overflow strips still works; only the
spurious vertical bar is hidden. Vertical tabs lists explicitly opt
back into y-axis visibility. No action-overflow regression possible.

### Q4b — A7 api-tokens truncate-with-tooltip exposes full token + secret?

**No.** Verified by reading `src/app/api/admin/tokens/route.ts:11-29`:
the Prisma `select` clause is `{id, name, permissions, lastUsedAt,
expiresAt, createdAt, revoked, user: {id, username}}`. No
`tokenHash`, no encrypted secret field, nothing of cryptographic
value is ever loaded. The tooltip just re-renders
`token.user.username`, `formatTokenName(token.name)`, and the
permission string. Token plaintext (`hlk_<64hex>`) is NEVER stored
in the DB — only HMAC-SHA-256 of the value. Even if the API leaked
the hash, it's not a usable secret.

### Q5 — A1 BD-Zielbereich percentages exposed via API/audit-log to
another user?

**No.** `/api/analytics` uses `requireAuth()` and scopes every
query by `user.id` (lines 25, 73, 77, 89). The
`bpInTargetPct{,7d,30d}` values are derived from THE CALLING
USER's own measurements only. The audit-log entry from
`annotate({ action: { name: "analytics.get" } })` (line 15)
records ONLY the action name without payload — no percentages, no
sample counts, no measurements ever land in the audit log.
No cross-user pathway exists.

### Q6 — Wave-B 27 fixes introduce dangerouslySetInnerHTML / new
endpoint / new storage?

**No.**
- `git diff v1.4.18...HEAD | grep dangerouslySetInnerHTML` → empty.
- `git diff --name-status v1.4.18...HEAD | grep "^A" | grep
  "src/app/api"` → empty (zero new API routes).
- Zero new Prisma models, zero new env vars consumed.
- The Wave-B sweep is i18n-string + `t()`-substitution + minor JSX
  restructuring (drop duplicate card titles, link audit rows, etc.).

### Q7 — General hygiene: logging respects redactSecrets, new routes
use apiHandler, new i18n keys can't pull arbitrary user input?

- **Logging**: zero new `annotate()` / `getEvent()` calls in the
  v1.4.19 diff (verified via
  `git diff … | grep -E "^\+" | grep -E "annotate|getEvent"` →
  empty). Existing `apiHandler` middleware continues to redact
  error messages via `redactSecrets()` per CLAUDE.md.
- **apiHandler**: zero new API routes added. Existing routes
  unchanged in their wrapping.
- **i18n placeholders**: only new placeholder is `{count}` in
  `settings.integrationPill.{minutes,hours,days}Ago`, fed an integer
  from `Math.floor(deltaMs / 60000)` in
  `src/components/settings/integration-status-pill.tsx:57-66` — not
  user-controllable. The `t()` implementation in
  `src/lib/i18n/context.tsx:121-145` does a plain
  `String.prototype.replace` and the result is rendered as text in
  JSX (React auto-escapes). No HTML interpolation path.
- **Chart-token strip regex** (`src/lib/insights/chart-tokens.ts:54`
  widened to `[A-Za-z0-9_]+`): apostrophe / quote / `<` / `>`
  characters all terminate the character class, so injection
  attempts like `metric:WEIGHT' onclick='alert(1)'` cleave cleanly
  on the apostrophe. Surviving prose is rendered as React text
  (auto-escaped).

---

## Sign-off

Phase-D security review: **CLEAR**. 0 CRITICAL, 0 HIGH, 0
ship-blockers. 3 MED/LOW observations are informational; none
require code changes for v1.4.19.

Recommend: ship v1.4.19 once the other parallel reviewers also
clear.
