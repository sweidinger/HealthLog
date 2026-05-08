# HealthLog v1.4.6 — Findings & Spec

Status: 2026-05-09 — handoff from the v1.4.5 deploy session. All findings
were produced by **four parallel audit agents** (dashboard visual, KI section,
admin panel, KI insights data window) against the v1.4.5 codebase
(`e8f4820`). A Playwright probe also visually verified the dashboard tile
strip at five viewports. **Verify each finding by reading the cited
file:line BEFORE editing — agents occasionally reference stale state.**

The single working-tree change carried over from the v1.4.5 session:
`src/components/charts/trend-card.tsx:85` — added `w-full` so the tile
component fills its grid cell. **Do not commit alone — fold into v1.4.6.**

---

## Tier 1 — Release blockers for v1.4.6

### T1 — Dashboard tile fill ✅ (already in working tree)

`src/components/charts/trend-card.tsx:85`

The TrendCard outer div had `flex h-full flex-col` but no `w-full`. As a
flex-child of a `<div className="flex">` wrapper, it took content width
instead of stretching to the grid cell. Visible on mobile-narrow (375px):
tile widths varied 122-166px in the same row. With `w-full` added, the
Playwright harness confirms the tiles fill their grid cells uniformly at
all viewports. Marc's primary complaint was "die Kacheln füllen den Platz
nicht aus" — this is exactly that.

**Verify after change:** Run the deep diagnose probe at multiple
viewports (`/tmp/v145-tile-deep-diagnose.js` from prior session if still
on disk; otherwise re-create — set `HL_SID` to a valid session and run
via `node /Users/marc/.claude/skills/playwright-skill/run.js
$probe`).

### T2 — `--muted-foreground` equals `--foreground` (no hierarchy)

`src/app/globals.css:97` (dark) and `:134` (light)

Currently `--muted-foreground: #f8f8f2;` is identical to
`--foreground: #f8f8f2;` in dark, and `#1f1f1f` in both for light. Every
secondary string (tile labels, "Ø7d:" prefixes, units, nav inactive
items) is rendered at the same brightness as primary text — visually flat.

**Fix:** dark → `--muted-foreground: #9aa3b3;` (dracula-comment).
Light → `--muted-foreground: #5b6273;`.

**Verify:** Visual diff at a few pages — dashboard, settings, admin —
should show clear emphasis between primary numbers and label/footer
text. WCAG AA contrast must still hold (≥ 4.5:1 against the surface).

### T3 — KI insights `primaryRecommendation` renders raw chart tokens

`src/components/insights/insight-advisor-card.tsx:411`

The base-system prompt (`src/lib/insights/prompts/base-system.ts:67`)
explicitly invites the LLM to embed `metric:WEIGHT` etc. tokens inside
`primaryRecommendation`. The renderer prints
`{insight.primaryRecommendation}` raw — no token-strip, no
`<InlineCharts>` parse. Result: when the model follows instructions,
the user sees literal `metric:WEIGHT` in their hero recommendation.

**Fix:** Apply the same pattern used at lines 419-423 for `summary`:
strip tokens for prose, parse and render via `<InlineCharts>`. Re-use
the existing helper.

### T4 — `aiBaseUrl` cross-provider leak (security)

`src/lib/ai/provider.ts:75, 312, 355`, `src/app/api/user/ai-provider/route.ts:54-62`

`buildUserProvider` and `resolveProviderForTest` reuse a single
`aiBaseUrl` column across providers. If a user once configured `LOCAL`
with `http://192.168.x.x/v1` and later switches to `OPENAI`, the stored
`aiBaseUrl` is still set, so `OpenAIClient` is constructed with
`baseUrl: row.aiBaseUrl ?? "https://api.openai.com/v1"` — sending the
user's OpenAI API key to their local server.

**Fix:** In the PATCH handler at `route.ts:54-62`, when `provider`
changes to anything other than `LOCAL`, wipe `aiBaseUrl`. Belt-and-
braces in `buildUserProvider`: ignore `aiBaseUrl` for `OPENAI` and
`ANTHROPIC` (use a hardcoded default). Add a unit test for
provider-switch with stale baseUrl.

### T5 — `/api/insights/generate` 502 → Cloudflare HTML rewrite

`src/app/api/insights/generate/route.ts:84-86`

Same Cloudflare-rewrites-5xx footgun the test endpoint just got fixed
for in v1.4.5. Parse failure returns `apiError("Failed to parse AI
response", 502)` → Cloudflare swaps the body for an HTML error page →
`await res.json()` in `ai-section.tsx:206-215` crashes with
`Unexpected token '<'`. The user has zero rate-limit budget left to
retry (2/hour) and sees nothing useful.

**Fix:** Map parse errors to **422** with a readable JSON error body.
Same one-liner pattern as the v1.4.5 ai/test fix (see CHANGELOG).

### T6 — Admin status-card hrefs broken

`src/components/admin/status-card-grid.tsx:147, 159, 177, 189, 210, 222`

Hrefs to non-existent routes/anchors:
- `/admin/users`, `/admin/audit-log` — sub-routes don't exist
- `/admin#integrations`, `/admin#monitoring`, `/admin#backups`,
  `/admin#maintenance` — anchor IDs don't match the rendered DOM
  (actual: `section-admin-services`, `section-admin-umami`, etc.)

Every "Manage users" / "View backups" CTA reloads `/admin` to top.
The `status-card-grid.test.tsx:105` only asserts `startsWith("/admin")`
— so this regression slipped through.

**Fix:** Point hrefs at the existing anchor IDs:
- Users → `/admin#section-user-management`
- Audit log → `/admin#section-login-overview`
- Integrations → `/admin#section-admin-umami`
- etc. Verify each anchor exists in the rendered DOM.

Tighten `status-card-grid.test.tsx` to assert each href anchor IS
present in the rendered admin page DOM (use `render(<AdminPage />)`
and assert `getByText(...)` for each section ID). Plain regex check is
not enough.

### T7 — Bug-report toggle has no effect (admin)

`src/app/api/bugreport/route.ts:47-49`, `src/app/bugreport/page.tsx:70`

The `bugReportEnabled === false` check lives on the legacy
`/api/bugreport` route. The actual form on `/bugreport` posts to
`/api/feedback`, which has no such gate. Result: toggling "Bug
reports off" in admin **does not actually hide or block** the form —
users still submit successfully into the local feedback inbox.

The CLAUDE.md / commit message claim ("the report button gracefully
disappears") is false.

**Fix:** Pick one approach:
- **(a)** Add `bugReportEnabled` to `/api/bugreport/status` and to
  `/api/feedback` POST so the form is hidden + blocked when off.
  Recommended.
- (b) Update copy to clarify the toggle only governs GitHub
  publishing.

Pick (a). Update i18n copy. Add an integration test that toggles the
flag off and asserts /bugreport returns 503 OR redirects.

### T8 — "Wipe all data" deletes more than the copy says

`src/app/api/admin/data/route.ts:44-47`

The DELETE handler also nukes `apiToken`, `withingsConnection`,
`auditLog`, `authChallenge`. The UI confirmation copy
(`admin.deleteAllConfirmDescription`) and the success toast
(`admin.deletedResult`) only mention measurements/medications/
intakeEvents.

Worse: `tx.auditLog.deleteMany({})` runs in the same transaction —
**every prior security-relevant entry is gone**. For a feature whose
primary purpose is auditability, this is wrong.

**Fix:**
- **Stop deleting `AuditLog`.** Keep the audit trail. (If retention is
  desired, add a separate maintenance route that prunes by age.)
- Reflect the actual scope in the response toast (the API already
  returns `apiTokens`, `withingsConnections`, `authChallenges`).
- Update i18n keys `admin.deleteAllConfirmDescription` to enumerate
  everything that gets cleared.

### T9 — KI per-card window 30 → 360 daily + 24 monthly (NEW SCOPE)

Affected files (one constant + one bucket-builder per file):

- `src/lib/insights/general-status.ts:15` — `GENERAL_STATUS_POINTS`
- `src/lib/insights/blood-pressure-status.ts:21` —
  `BLOOD_PRESSURE_STATUS_POINTS` + `mood.slice(-30)` at line 362
- `src/lib/insights/pulse-status.ts:17` + line 199 mood-slice
- `src/lib/insights/weight-status.ts:17` + line 233 mood-slice
- `src/lib/insights/bmi-status.ts:11`
- `src/lib/insights/mood-status.ts:14` + line 283 (`recentEntries`
  slice 90 — already padded × 3)
- `src/lib/insights/medication-compliance-status.ts:150` —
  `rangeStart`

**Goal:** the LLM should see ~3 years of history with newer data at
higher resolution. Not raw rows — daily means for the recent window,
monthly means for the older window. Marc explicitly asked for
"mindestens 360 Tage" daily, plus "Monatswerte" for "2 oder 3 Jahre".

**Concrete shape of the prompt payload (per metric):**

```ts
{
  daily: Array<{ dayOffset: number; value: number; n: number }>; // 360 items, dayOffset 0..359 (newest first)
  monthly: Array<{ monthOffset: number; value: number; n: number }>; // 24 items, monthOffset 12..35 (12 months ago to 36 months ago)
}
```

So months 1-12 are sampled daily (= 360 daily buckets), months 13-36
are summarised monthly (= 24 monthly buckets). Total 384
data points per metric.

**Token budget guard:** Before sending, log the JSON-stringified
payload size. If >50 KB, fall back to 180 daily + 24 monthly. Add
this as a `LOG_INSIGHTS_PAYLOAD_SIZE` env var (default true) so we
can monitor.

**Tests:** add a test per generator that asserts the payload contains
both `daily` and `monthly` arrays with the expected lengths, and that
no raw measurement rows leak into the prompt (the audit window is
3 years; raw mode is unchanged in `features.ts`).

---

## NEW FEATURE — Chart bucketing for ranges > 1 year

Marc's request:

> "Überlege dir bei den Charts ob wir Sachen halt nicht ab einer
> gewissen Sache dann stacken in den Monaten. Wenn wir jetzt bei
> All drücken zum Beispiel, dass man dann halt ab einer Zeit von
> über einem Jahr dann halt danach tagesmonats- oder monats- oder
> wochendurchschnitte summiert und nicht dann 30.000 Punkte
> anzeigt"

**Spec:**

The chart data adapter (in `src/components/charts/` — likely
`health-chart.tsx` or a sibling) currently renders every measurement
in the selected range. For the dashboard "All" / "Alle" range filter
this can be 1000s of points and is unreadable.

Add **automatic bucketing** based on the rendered range:
- `≤ 90 days` → daily points (current behaviour)
- `91-730 days` → weekly average
- `> 730 days` → monthly average

The bucket type must be displayed in the chart header
(e.g., "Tageswerte" / "Wochendurchschnitt" / "Monatsdurchschnitt"
chip in the corner of the chart) so the user knows what they are
looking at.

The data points must keep their ISO timestamps so Recharts' x-axis
formatting works correctly. Smoothing/averaging must skip days
with `n=0` rather than count them as `0`.

**Tests:** unit-test the bucketing function with synthetic series of
varying length. Visual regression: render the chart at a 2-year range
and verify the chart shows ~24 monthly points, not 730 daily.

**Research:** the autonomous executor MUST research best practice
for time-series bucket aggregation in healthcare/Recharts dashboards
before implementing. Use Context7 or websearch for "recharts
aggregation buckets" and similar — there's a standard pattern for
this. Don't reinvent.

---

## Tier 2 — Polish (also for v1.4.6)

| ID | File | Change |
|----|------|--------|
| P1 | `trend-card.tsx:93,109,118,130,139` | Add `tabular-nums` to numeric spans (digits jiggle on refresh) |
| P2 | `trend-card.tsx:87,93` | Bump value `text-2xl` → `text-3xl tracking-tight`, label `text-sm font-medium` → `text-xs uppercase tracking-wide` (KPI hierarchy) |
| P3 | `trend-card.tsx:85` vs `health-chart.tsx:551` | Match padding: tile `p-3` → `p-4 md:p-6` to align with chart cards |
| P4 | `trend-card.tsx:64-69` | Trend-arrow color: keep flat at muted; up/down both `text-foreground` (neutral). Direction-as-good-or-bad is metric-specific and v1.5+ work. |
| P5 | `trend-card.tsx:103-145` | Always render avg7/avg30 chips; use `—` when null so vertical rhythm is consistent across tiles |
| P6 | `page.tsx:362` | Welcome subtitle: drop `hidden sm:block`, add `text-muted-foreground` (visible on mobile, muted) |
| P7 | `auth-shell.tsx:129` | Bottom-nav buffer: `pb-[calc(5rem+env(safe-area-inset-bottom,0px))]` → `pb-[calc(4rem+env(safe-area-inset-bottom,0px))] md:pb-0` |
| P8 | `empty-state.tsx:71-77` | TrendHint title default: add `text-muted-foreground` so the title doesn't fight chart titles after T2 |
| P9 | `getting-started-checklist.tsx:299` | Drop `font-mono` from "X von Y" / "%" — keep `tabular-nums` |
| P10 | `page.tsx:846-862` | Medications card: `rounded-lg border p-4` → `rounded-xl border p-4 md:p-6` (match other chart cards) |
| P11 | `src/lib/logging/redact.ts:22` | Add `sk-(ant-)?` regex to `redactSecrets` to scrub OpenAI/Anthropic keys centrally |
| P12 | `src/lib/idempotency.ts:227` | Extend the `hlk_` / `hlr_` exclusion to also reject bodies containing `"sk-"` or `"sk-ant-"` |
| P13 | `src/app/api/insights/generate/route.ts:18-22` | Move `checkRateLimit` BELOW the cache-return so cached hits don't burn rate-limit tokens |
| P14 | `src/lib/ai/codex-client.ts:28,34` | Copy structured-error pattern from `openai-client.ts:42-58` (httpStatus, bodyExcerpt, upstream fields) |
| P15 | `src/components/settings/ai-section.tsx:49` | Drop `gpt-5` from `MODEL_PRESETS["OPENAI"]` (not a released model). Drop `o3-mini` too unless you wire the o-series param contract (`max_completion_tokens` not `max_tokens`, no `temperature` override). |
| P16 | `src/components/settings/ai-section.tsx` (~29 strings) | i18n: pipe German strings through `t("settings.ai.…")` — add keys to `messages/en.json` + `messages/de.json` |
| P17 | `src/components/admin/feedback-inbox-section.tsx:209-222` | Replace `bg-red-500/15 text-red-400` with `bg-dracula-red/15 text-dracula-red` etc. for theme consistency |
| P18 | `src/components/admin/danger-zone-section.tsx:110` | Drop string-prefix-matches-success heuristic — track via `mutation.isSuccess` / `mutation.isError` |
| P19 | `src/components/admin/_shared.tsx:268-277,216-225` | `useSystemStatus()` and `useAdminSettings()`: surface `isError` with an inline "Failed to load settings" message instead of infinite spinner |
| P20 | `src/app/api/admin/status-overview/route.ts` | `Promise.all` → `Promise.allSettled` server-side so one failed probe doesn't blank the whole grid |

---

## Tier 3 — explicitly deferred

- **One-row scroll vs. wrap** — the dashboard audit recommended
  rolling back v1.4.5's wrap behaviour to v1.4.4's horizontal-scroll-
  always. Marc already chose wrap deliberately in v1.4.5
  (CHANGELOG entry, commit `e8f4820`). **Do not roll back.**
- **`/admin/users`, `/admin/audit-log` sub-routes** — feature, not
  bug. Anchor-link fix in T6 is enough for v1.4.6.
- **API token revoke / login block actions** in admin — feature for
  v1.5.
- **"Remove saved AI key" button** — UX gap, not a bug. v1.5.
- **Feedback / mood semantic colors** — needs design pass.

---

## Verification gates (before tagging v1.4.6)

After all fixes, the autonomous executor MUST:

1. **Test suite green:** `pnpm test`, `pnpm typecheck`, `pnpm lint`,
   `pnpm format:check`. Stop if any fails — never `--no-verify`.
2. **Integration tests green** (testcontainers): `pnpm test:integration`
3. **Build succeeds:** `pnpm build` (no Turbopack-specific failures)
4. **Multi-agent QA review** — dispatch in parallel and reconcile
   findings into a follow-up commit if any HIGH/CRITICAL surfaces:
   - **superpowers:code-reviewer** — review the v1.4.6 diff vs. main
   - **Plan agent** as senior-design-reviewer — visual review of
     dashboard, settings, admin at desktop + mobile viewports
   - **Plan agent** as senior-security-reviewer — review T4, T5, T7,
     T8, P11, P12 specifically for residual risk
   - **simplify skill** — run on the v1.4.6 changed files to look for
     accidental complexity
5. **Mobile QA** via Playwright — at least three viewports
   (375×667, 390×844, 412×915). Probe must verify:
   - No horizontal scroll on any page
   - Bottom-nav doesn't overlap content
   - Tile strip wraps cleanly with uniform widths per row
   - Touch targets ≥ 44×44 px
   - Charts render and are readable
6. **Hallucination check** — for every finding fixed, `git diff` must
   show a real change at the cited file:line. Audit-agent claims must
   be verified; if a finding's file:line doesn't match what's
   actually there, log it in the SUMMARY and skip rather than guess.
7. **Visual regression** — Playwright screenshots of dashboard at
   1280×900 and 390×844, before+after, saved to
   `/tmp/v146-tiles-{desktop,mobile}-{before,after}.png`.

---

## Release & deploy

1. Bump `package.json` to `1.4.6`
2. Update `CHANGELOG.md` with a `[1.4.6] — 2026-05-09` (or `2026-05-10`
   depending on completion time) block. Tone: user-facing German +
   English, **no Claude mention, no "Audit-Agent"**, no internal
   phase names. Group by section: "Fixed — Dashboard",
   "Fixed — KI", "Fixed — Admin", "Improved — KI Insights",
   "Improved — Polish".
3. Atomic commits per phase, each Co-Authored-By Claude Opus 4.7.
4. Tag `v1.4.6`, push tag.
5. Wait for GHCR build (typically 10-13 min).
6. Coolify deploy: `mcp__coolify-apps01__deploy` with
   `tag_or_uuid: pg8wggwogo8c4gc4ks0kk4ss`, `force: true`.
7. Verify production:
   - Poll `/api/version` until 1.4.6
   - `docker inspect` running container — image digest must
     differ from current.
   - Marc's session: `cmox4d6fj000101p8w9ykhcnm` (still valid as of
     2026-05-09; if expired, re-pull from prod DB —
     `SELECT id FROM sessions WHERE user_id='cmlupy4tn000001rpzx1pxvz7'
      AND expires_at > now() ORDER BY created_at DESC LIMIT 1;`)
   - Hit `/api/ai/test` with fake key → still returns 422
   - Hit `/api/insights/generate` with `forceRefresh=false` and a
     fresh user → does not consume rate-limit token (P13 verify).
8. Mobile QA Playwright probe against production.
9. Brief Marc — German, ≤ 200 words. Hard-reload reminder.
   Group by what changed perceptually ("Tile-Strip füllt jetzt aus",
   "KI bekommt jetzt 3 Jahre Historie", "Charts aggregieren bei
   Langzeit-Range", "Admin-Buttons springen jetzt zum richtigen
   Anker", "Bug-Report-Toggle wirkt jetzt"). No "Claude", no
   internal phase names.

---

## Repo housekeeping (also in scope for the v1.4.6 marathon)

### CI

- `e2e` workflow has been **failing on every commit** since at least
  `cbded7c3`. Investigate (`gh run view <id> --log-failed`), root-
  cause, fix the spec or the underlying app bug. Don't `.skip()` it
  — Marc explicitly asked for green CI.

### GitHub Releases

GitHub Releases stop at **v1.4.1**. Backfill v1.4.2, v1.4.3, v1.4.4,
v1.4.5, v1.4.6 — each release notes pulled from the corresponding
`CHANGELOG.md` block. Tag each release `--verify-tag` so we don't
create an orphan release.

### GHCR Packages

`ghcr.io/mbombeck/healthlog` packages page may have stale tags from
the v1.4.0/v1.4.1 deploy thrash. Don't delete `v1.x.x` tagged
versions (some users may pin). Only delete explicitly *untagged*
manifests if any exist.

### Docs site (`/Users/marc/Projects/healthlog-docs`)

Astro site at `https://docs.healthlog.dev`. Latest content covers
**up to v1.2**. Bring it up to v1.4.6:

- Update version selector / Latest indicator
- Add docs pages or sections for v1.3-v1.4.6 features the user
  would care about — read the CHANGELOG.md user-facing bullets
  and translate into how-to docs where appropriate
- Add the v1.4.6 release entry

Read the docs repo's CLAUDE.md/CONTRIBUTING (if present) FIRST to
understand conventions. Commit + push.

### Landing site (`/Users/marc/Projects/healthlog-landing`)

Next.js site. Latest showcase mentions v1.2. Minimal updates only —
don't redesign:

- Update headline version + supported-features list if anything
  v1.3-v1.4.6 is landing-page-worthy
- Update screenshots if anything visibly changed (likely the
  dashboard tile strip)

Commit + push.

---

## Marc's hard rules (verbatim)

1. Niemals `--no-verify` bei git commit.
2. Niemals `--no-gpg-sign` außer explizit angefragt.
3. **Niemals force-push to main.**
4. Changelogs/Release-Notes nur user-facing — kein "Claude", keine
   internen Phasennamen, keine Audit-Sprache.
5. Authorization gilt nur für den spezifischen Auftrag — wenn etwas
   Größeres aufkommt, lieber fragen als entscheiden.

For this overnight session, Marc has explicitly authorized
**autonomous execution of Tier 1 + Tier 2 + the new chart bucketing
feature**, and the multi-agent QA + simplify pass. Anything that
crops up which is **not** in this document and is **larger than a
typo-level change** must be deferred to v1.5 with a note in the
SUMMARY rather than implemented.
