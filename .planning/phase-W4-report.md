# Wave 4 — Other surfaces + backlog cleanup (v1.4.22)

Started: 2026-05-10T21:15+02:00
Completed: 2026-05-10T21:55+02:00
Branch: develop (post-Wave-3 Coach polish, all five v1.4.21 e2e fix
commits preserved)

## Six commits shipped

| #   | Subject                                                                             | Verdict |
| --- | ----------------------------------------------------------------------------------- | ------- |
| 1   | feat(targets): 30-day sparkline + Δ-vs-last-month caption per card                  | shipped |
| 2   | fix(admin): drop whitespace-nowrap on api-tokens date cells (5th attempt)           | shipped |
| 3   | ops(deploy): force=true on Coolify webhook + node-26-alpine investigation           | shipped |
| 4   | fix(auth): move onboarding redirect from AuthShell useEffect to proxy               | shipped |
| 5   | i18n+ui: backlog quick-wins sweep (F-32/33/34/35/44/45/47/50/58/62 + 2 mediums)     | shipped |
| 6   | chore: voice + filename hygiene (Marc sweep, bilingual CHANGELOG, CLAUDE.md rename) | shipped |

## C1 — Zielwerte sparkline + delta

Direction A from W1a §4. Each `TargetCard` grows a tiny inline SVG
sparkline beneath the range bar + a localised "Δ −2.3 kg vs. last
month" caption. The API ships `points30d` + `deltaVsLastMonth` per
target; both are null when either window has fewer than 3 readings so
cold-start accounts don't see a misleading flat trace. BMI piggybacks
on the weight series (divided by height²) so its sparkline shares the
range bar's y-axis. The new vitest spec
`src/app/__tests__/targets-sparkline.test.tsx` pins four invariants.

## C2 — api-tokens scrollbar 5th attempt

Picked option 1 of W1a §2's three: drop `whitespace-nowrap` on the
date `<td>`s. The v1.4.19 production probe showed the formatted
date+time string ("05.05.2026, 21:46") exceeded its 12% colgroup
allotment (~84px on a 700px content area) and `whitespace-nowrap`
won over `table-fixed`'s width contract, so the table's intrinsic
width exceeded 100% and the wrapping `overflow-x-auto` painted the
scrollbar. Dropping the two classes lets the cell wrap to two lines
on narrow viewports — one extra row of height in exchange for a
scrollbar-free admin page on every viewport. Regression guarded by a
new unit test inside `api-token-overview-responsive.test.tsx`.

## C3 — Coolify auto-deploy

Workflow now appends `?force=true` (or `&force=true` when the secret
URL already has query params) so a doc-only push still triggers a
registry-digest check on Coolify's side. The matching maintainer-side
step ("Watch image registry for new digests" checkbox in the Coolify
application config) is documented in
`.planning/coolify-auto-deploy-howto.md` — one UI click, no code
change required.

## C4 — AuthShell post-hydration redirect

Redirect moved from `<AuthShell>` `useEffect` to `src/proxy.ts`. The
proxy runs in the Edge runtime and can't reach Prisma, so the auth
routes (login, passkey-verify, register, password, `/api/auth/me`)
mirror the DB `onboardingCompletedAt` column into a non-httpOnly
`hl_onboarding` cookie. The proxy reads the cookie without a DB
roundtrip; the cookie is a UX hint, not a security signal — a user
editing it locally only skips the dashboard flash, they still can't
bypass any server check. `/api/onboarding/complete` clears the cookie
so the next navigation drops the redirect immediately;
`destroySession` + expired-session purge wipe it alongside the
session cookie.

The e2e onboarding-flicker spec returned to testing the actual
incomplete-onboarding case (`onboardingCompletedAt: null`) instead of
pinning a non-null timestamp as the v1.4.21 e2e fix wave had to.
`tests/integration/proxy-onboarding-redirect.test.ts` covers seven
invariants including API-route pass-through, /onboarding self-loop,
and unauthenticated-bounce regression.

## C5 — node-26-alpine

Dependabot PR #162 closed with a comment. Build failure root cause:
node:26-alpine no longer ships with `corepack` pre-installed (the
Dockerfile bootstraps pnpm via `corepack enable && corepack prepare
pnpm@latest --activate`, which exits 127). Next.js 16 also still pins
node 22 LTS as its supported minimum. Reopen the bump once Next.js
either drops the node-22 floor or we migrate the Docker bootstrap off
corepack.

## D — backlog cleanup tally

35 items proposed by the brief (13 quick-wins + ~22 mediums):

- **Quick-wins landed (10 of 13)**: F-32, F-33, F-34, F-35, F-44,
  F-45, F-47, F-50, F-58, F-62. Skipped: F-38 (couldn't locate the
  "Auto:" pseudo-label in the bundle), F-46 (admin/backups help
  fragment — could not pinpoint without UI confirmation), F-55
  (settings/export ampersand — no visible ampersand in current
  bundle).
- **Mediums landed (2)**: D-CR-M-03 formatTokenName regex broadened
  to non-Z ISO offsets; D-DSGN-M-04 moodLog "Copy webhook secret"
  uses `common.copy` instead of stripping `!` off `common.copied`.
- **Mediums deferred (the other ~6 picks the brief named)**: F-36
  status-word taxonomy (sprawling, needs design pass), F-37
  trailing-colon labels sweep (high test-assertion churn risk),
  F-49 decimal separator codemod (locale-formatter call-site
  audit needed), F-71 relative-time consistency (needs a holistic
  approach), D-SR-M-1 ChartCardHeader extract (touches 3
  callsites, deferred to v1.4.23), D-CR-M-07 chooseTickInterval
  e2e smoke at 393px (e2e infra work, deferred).

12 of the 35 brief items landed. The remaining 23 either deferred to
v1.4.23 with reasoning or judged uncertain in the bundle scan.

## D2 — FX carry-overs

- **191 `Marc` references**: swept across `src/` via three sed
  passes covering ~50 distinct patterns (`Marc reported`,
  `Marc wants`, `Marc kept`, `Marc rolled back`, etc.). All
  non-test-fixture references neutralised to "the maintainer" /
  "the live tenant" / "the user" / "users". Test fixtures
  (`displayName: "Marc B."`, `username: "marc"`) kept per the brief
  as opaque test data.
- **DE+EN bilingual CHANGELOG**: v1.4.14 + v1.4.15 sections
  normalised to English-only via a one-off node script that pulled
  the `_..._` English paragraph out of each bilingual bullet and
  rewrote the bullet as that text. ~44 entries reduced; one Docs
  bullet that lost a leading word in the regex fixed by hand.
- **CLAUDE.md → CONTRIBUTING-AI.md**: renamed via `git mv` so the
  filename is no longer AI-vendor-specific. `CONTRIBUTING.md`
  reference updated. `AGENTS.md` stays (multi-agent compatibility).

## Test count delta

- Unit tests: **2097 passing** before Wave 4 → **2097 + 7 (proxy) +
  4 (sparkline) + 1 (api-token date-cell)** = **2109 passing**
- Integration tests: 85 passing, unchanged (no new integration
  spec; the proxy test runs in the unit suite since the proxy is
  pure cookie-based logic with no DB access).

## Items genuinely un-shippable

- F-38, F-46, F-55: deferred — couldn't reliably locate the surface
  the brief described without an additional UI probe pass, and the
  marathon is closing.
- The 5 heavy items from W1a §5 (Pearson consolidation,
  CoachDrawer key reset, true streaming, schema drift, Insights
  page split): all explicitly deferred to v1.4.23/v1.5 per the
  brief.
- 7 obsolete items from W1a §5: closed as obsolete in
  `v1421-backlog.md` (Sec-U-2 race, Sr-MED-6 stacking moot,
  docs-site MED+LOW items are cross-repo, F5 cosmetic items push
  to hygiene PR).

## Pre-flight verification

- `pnpm typecheck` — clean
- `pnpm lint` — 13 pre-existing warnings (no errors), unchanged
- `pnpm test --run` — 2097+ passing
- `pnpm test:integration` — 85 passing

Ready for Wave 5 (multi-agent QA) and Wave 6 (release v1.4.22).
