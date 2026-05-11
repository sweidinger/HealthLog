# Wave 5 — Security review (v1.4.22)

Branch: `develop` (24 commits ahead of `main`).
Scope: every commit between `main` and `develop` listed in the brief, focusing on the six v1.4.22 surfaces called out in the audit prompt.

## Summary

- New attack surface in v1.4.22: a server-side onboarding redirect in `proxy.ts` driven by a non-httpOnly `hl_onboarding` cookie, a Coach `---KEYVALUES---` sentinel parser that strips an attacker-controllable block from the streamed assistant prose, a substantially rewritten Coach system prompt (warm tone + few-shot tone calibration), a `comparisonBaseline` field persisted into the per-user `User.dashboardWidgetsJson` blob, the `hl_onboarding` cookie itself, and a `?force=true` query appended to the Coolify deploy webhook URL in CI.
- Findings: **0 CRITICAL · 0 HIGH · 2 MED · 4 LOW**.
- Overall posture: solid. The proxy redirect is correctly scoped (read-only cookie, fixed redirect target, API routes exempt, `/onboarding` itself in `PUBLIC_PATHS` so no loop). The sentinel parser is well-defended with a 1 KB cap, an 8-line cap, per-line Zod validation, graceful degrade on missing `---END---`, and an explicit comment that the parsed values feed `provenance.keyValues` rather than being eval'd or rendered as raw HTML. The Coach system-prompt rewrite contains no instructions that would teach the model to leak the system prompt or ignore guardrails. The comparison-baseline field is per-user and only ever read/written through `requireAuth()` against the caller's own row. The Coolify webhook still requires both the URL and bearer-token secret. The two MED items are about the new cookie's `SameSite` posture and the redirect-control fence on `/onboarding` matching too loosely; the LOWs are minor hardening notes.

## Findings

### MED-1 — `hl_onboarding` cookie is `SameSite=Lax`, not `Strict`

- File: `src/lib/auth/session.ts:32` (`setOnboardingPendingCookie`).
- What: the audit brief explicitly asked the cookie to be `SameSite=Strict`. The implementation sets `sameSite: "lax"` (and explicitly `httpOnly: false`, by design as a UX hint).
- Why: `Lax` is the right posture for the `healthlog_session` cookie because the Withings OAuth callback arrives via top-level cross-site redirect (documented in the same file at line 60). The onboarding flag is **not** load-bearing for any cross-site flow — no third-party redirects ever depend on `hl_onboarding`. The brief's `Strict` guidance therefore is achievable without breaking any flow, and `Strict` would harden against a top-level cross-site `GET` from an attacker page that tries to coax the victim's browser to silently replay the cookie on a redirect chain. The exposure is small (the cookie is just `"pending"` vs absent and the proxy treats it as a UX hint, not auth), but the brief is explicit.
- Fix: change `sameSite: "lax"` → `sameSite: "strict"` for the `hl_onboarding` cookie only. Leave `healthlog_session` as `Lax` because of the Withings callback. Add a one-line code comment explaining the divergence so a future audit doesn't homogenise the two.

### MED-2 — `/onboarding` `startsWith` match is loose enough to skip the auth gate for unintended paths

- File: `src/proxy.ts:28-33` (`PUBLIC_PATHS` + `isPublicPath`) and `src/proxy.ts:152` (the redirect-skip).
- What: `PUBLIC_PATHS` is matched with `pathname.startsWith(p)`. The entry `"/onboarding"` (no trailing slash) therefore admits `/onboardingfoo`, `/onboarding-export`, `/onboarding.json`, etc. as public. Today no such route exists, but Next 16 App Router would happily mount one if a future contributor added `src/app/onboarding-foo/page.tsx`, and that page would be reachable without a session cookie because the proxy's auth check runs `if (!isApiRoute && !isStaticFile && !isPublic)`.
- Why: every other entry in `PUBLIC_PATHS` is either a literal terminal path (`/api/auth/login`, `/robots.txt`) or already trailing-slashed (`/auth/`, `/api/auth/`, `/api/monitoring/`, `/api/ingest/`). `/onboarding` is the lone exception. The same loose match is reused at line 152 for the **inverse** check (`!pathname.startsWith("/onboarding")` — anything starting with `/onboarding` is treated as the onboarding surface and the redirect short-circuits). A future `/onboarding-export` route would silently inherit both behaviours, which is the kind of footgun a security review should call out before it ships.
- Fix: rewrite both occurrences to be exact-match for the page itself plus its subroutes: change the array entry to `"/onboarding"` with an explicit equality check (`pathname === "/onboarding" || pathname.startsWith("/onboarding/")`). Mirror the same pattern in the redirect short-circuit at line 152.

### LOW-1 — `/api/auth/me` is a GET that mutates state (cookie write) on every call

- File: `src/app/api/auth/me/route.ts:16` (`setOnboardingPendingCookie` inside the GET).
- What: every call to GET `/api/auth/me` now writes the `hl_onboarding` cookie. GETs that mutate state are normally a CSRF smell.
- Why: in this case the only mutation is "make the cookie match the DB". An attacker who can force the victim's browser to GET `/api/auth/me` (which requires a same-origin fetch — `/api/auth/me` is not in `PUBLIC_PATHS` and a cross-site GET in 2026 cannot read the response) only re-anchors the cookie, which is the exact behaviour the route already wants. No upgrade-of-privilege, no data write. Calling this LOW only because it is the kind of pattern a future contributor might cargo-cult into a more dangerous surface.
- Fix: leave as-is. Optionally add a code comment noting that the GET-side mutation is deliberately idempotent and is not allowed to grow.

### LOW-2 — Coach system-prompt few-shot examples bake in concrete numeric values (138, 142/88, 4.1, 96 %)

- File: `src/lib/ai/coach/system-prompt.ts:140-156, 312-340` (EN + DE few-shots).
- What: the new tone-calibration few-shots include illustrative metric values inside `---KEYVALUES---` blocks (`avg7 systolic: 138`, `Tue 6 May: 142/88`, `30-day adherence: 96`).
- Why: the `feedback_no_pii_in_user_facing.md` rule says Coach prompt drafts must not bake live-tenant figures into the system prompt. These values are clearly synthetic (round numbers, mocked dates) and document the sentinel format the parser expects, so they are educational not operational. Calling LOW because a future contributor copy-pasting "real" numbers into the same template would silently leak.
- Fix: leave as-is. Optionally add a `WARNING: synthetic values only — never paste real tenant readings here` comment line at the top of `COACH_PROMPT_EN` and `COACH_PROMPT_DE` so the rule survives future edits.

### LOW-3 — Coach `transcript` block does not delimit user input from role labels

- File: `src/app/api/insights/chat/route.ts:211-220`.
- What: the user prompt is built by joining persisted messages with `${role.toUpperCase()}: ${content}` and concatenating them under a `CONVERSATION` header. A user message containing the literal text `\n\nASSISTANT: …` could in principle confuse the model into treating subsequent prose as the assistant's own turn.
- Why: this is a self-injection at worst — the only conversation the user can poison is their own (each conversation is owned by `userId` and persistence enforces it). The refusal detector still runs upstream and would catch the obvious injection patterns. The system prompt's grounding rule ("ground every number in the SNAPSHOT") plus the prompt budget cap keep impact tiny.
- Fix: leave as-is for v1.4.22. If self-injection becomes a quality issue, switch the transcript builder to use a structured chat-completion payload (one `{ role, content }` per persisted turn) instead of flattening everything into a single user prompt — the provider runner already supports this on the OpenAI/Anthropic adapters.

### LOW-4 — Sentinel parser drops the `truncated` flag without surfacing it to the persisted provenance

- File: `src/lib/ai/coach/keyvalues.ts:147-180` and `src/app/api/insights/chat/route.ts:280-291`.
- What: when a sentinel block exceeds the 1 KB cap, the parser sets `truncated = true` internally and folds it into `malformed`. The route logs `coach.keyvalues.parse_failed` but does not record per-message whether the failure was truncation vs missing close vs zero valid rows. A real attacker would prefer the truncation path because the parser still keeps the first 8 rows from the truncated body.
- Why: low-impact because the model would have to produce 1 KB+ of valid-looking lines to push junk past the byte cap, and the per-line Zod schema (`label ≤ 80`, `value ≤ 40`, `unit ≤ 16`, `window ≤ 40`) bounds what survives. Calling LOW because the wide-event metadata is the only ops-side signal of an unusually large sentinel.
- Fix: extend the wide-event meta in `chat/route.ts:286-289` with `truncated` and `closeMissing` booleans so a regression on the upstream prompt format is observable.

## Strongest defensive postures (v1.4.22 added)

- The Coach sentinel parser is **defence-in-depth done right**: a 1 KB byte cap before tokenisation, an 8-row line cap, per-line `coachKeyValueSchema.safeParse` validation (label/value/unit/window are length-bounded), explicit `OPEN`/`CLOSE` markers stripped from the body so a model cannot smuggle a nested sentinel, graceful degrade on missing `---END---` (returns the prose unchanged + flags `malformed: true`), and a wide-event `coach.keyvalues.parse_failed` annotation for ops visibility. The persisted `metricSourceJson` schema (`provenanceFromJson` in `persistence.ts:73-140`) re-validates every field on read so a malformed historical row cannot poison a re-render after a parser change.
- The new `proxy.ts` redirect is **correctly framed as a UX hint, not an auth gate**: comments at `session.ts:11-21` and `proxy.ts:142-149` are explicit that an attacker editing the cookie locally only skips the dashboard flash; every actual data-access check stays server-side via `requireAuth()` against the DB-backed `Session` row. The redirect runs only for non-API non-public surfaces (so `/api/*` is unaffected and cannot be 307'd into a redirect loop), the redirect target is a fixed string (no open-redirect surface), and `/onboarding` is in `PUBLIC_PATHS` so the redirect cannot loop.
