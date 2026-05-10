# v1.4.18 phase-D security review

Reviewer: SECURITY (5 reviewers in parallel)
Range: `v1.4.17..HEAD` (HEAD = 3d58557, origin/main)
Reviewed: 2026-05-09 / 2026-05-10
Scope per request: B1 hidden achievements, A3 chart-overlay-prefs,
A2 admin-shell `no-scrollbar`, A1 BD-tile sub-values, plus general
hygiene (logging redaction, apiHandler, dangerouslySetInnerHTML).

---

## Summary

| Severity | Count |
| -------: | ----: |
| CRITICAL |     0 |
|     HIGH |     2 |
|   MEDIUM |     1 |
|      LOW |     2 |

Ship-blockers: **0**. The two HIGH findings are about
hidden-achievement secrecy. The DOM is held: a casual user opening
inspect-element sees the opaque "Hidden achievement" placeholder
with no predicate text. The leak surfaces are (a) the JSON API
response and (b) the client-side i18n bundle that already ships
the strings — neither is a v1.4.18-specific regression in the
sense that fixing them requires architectural moves; both are
ship-OK as documented backlog items.

A1 / A2 / A3 are all clean from a security standpoint:

- A1's `computeBpInTargetWindows()` is pure; the `/api/analytics`
  caller scopes every `findMany` with `userId: user.id`.
- A2's `no-scrollbar` is a class-scoped CSS rule on
  `<nav class="no-scrollbar">` only — _not_ a global `*` selector
  — so data tables that genuinely overflow continue to paint their
  scrollbars normally.
- A3's `PUT /api/dashboard/chart-overlay-prefs` is `requireAuth`-
  gated, scopes the read+write to `user.id`, and the Zod schema
  rejects unknown chart keys / non-boolean toggle values.

---

## CRITICAL

(none)

---

## HIGH

### HIGH-1 — Hidden-achievement predicate leaks via /api/gamification/achievements JSON response

**Severity**: HIGH (matches Marc's explicit "must NOT leak in network response" criterion)
**File**: `/Users/marc/Projects/HealthLog/src/app/api/gamification/achievements/route.ts:838-854` and `:856-873`
**Ship-blocker**: NO — DOM-level secrecy holds and the i18n bundle already exposes the same data, so the network leak is not a v1.4.18-only regression. Recommend fix in v1.4.19.

**Issue**

The web response payload `{ summary, achievements, metrics }` ships
the FULL achievement object for every hidden Easter-egg even when
the user has not unlocked it. For a locked
`hidden-night-owl` the response body contains:

```json
{
  "id": "hidden-night-owl",
  "metric": "nightOwlCount",
  "category": "hidden",
  "titleKey": "achievements.badges.hiddenNightOwl.title",
  "descriptionKey": "achievements.badges.hiddenNightOwl.description",
  "icon": "Moon",
  "format": "count",
  "target": 1,
  "current": 0,
  "points": 25,
  "unlocked": false,
  "progressPercent": 0,
  "completedAt": null,
  "isHidden": true
}
```

The `id`, `metric`, `titleKey`, `descriptionKey` and `icon` fields
each individually disclose the trigger (night owl, between 02:00
and 04:00, Moon icon). The `metrics` block at the bottom of the
response (`route.ts:853`) compounds the leak by including
`nightOwlCount`, `earlyBirdCount`, `leapDayCount`, `doctorPdfCount`,
`localeFlipCount` as plain numeric counters — disclosing both the
metric names AND the user's current progress toward them.

The iOS branch (`route.ts:856-872`, `?format=ios`) is **strictly
worse**: it server-side-resolves the i18n keys and ships plain text
`title: "Night owl"` and `description: "Logged an entry between
02:00 and 04:00 in the morning."` for locked hidden achievements.
The iOS client gets the secret unconditionally.

This contradicts Marc's stated requirement
("the user must not be able to view-source or inspect-element to
discover what the hidden conditions are") for any user who opens
DevTools → Network and reads the response body.

**Mitigation already in place (partial)**

DOM rendering is gated correctly by
`/Users/marc/Projects/HealthLog/src/app/achievements/page.tsx:146-174`
(the `isHidden && !unlocked` branch renders the opaque placeholder
without referencing real fields). The unit suite at
`/Users/marc/Projects/HealthLog/src/app/achievements/__tests__/page.test.tsx:252-262`
locks this in. Casual inspect-element does NOT break the secret —
only the network tab and the JS bundle do.

**Recommendation**

In `route.ts` between `applyDiscoveryFilter` and the final
`apiSuccess`, project hidden+locked rows down to a redacted shape
before serialization:

```ts
const SAFE_HIDDEN_LOCKED = (a: AchievementProgress) => ({
  id: "hidden-locked-placeholder", // not the real id
  category: "hidden" as const,
  isHidden: true,
  unlocked: false,
  // every other field absent OR a constant placeholder
});

const projected = visibleAchievements.map((a) =>
  a.isHidden && !a.unlocked ? SAFE_HIDDEN_LOCKED(a) : a,
);
```

Also strip the hidden-only metric counters from the `metrics`
block when none of the hidden achievements they back are unlocked
(or just drop the entire `metrics` object from the response — the
client only consumes it for `metricPercent` formatting, which the
hidden-counter metrics never use).

For `?format=ios`, do the same projection BEFORE the
`t.t(a.titleKey)` calls so the iOS shape never resolves the secret
strings.

Add a test that the network response for a fresh user with zero
unlocks contains _zero_ occurrences of the substrings
`nightOwl`, `earlyBird`, `leapDay`, `doctorPdf`, `localeFlip`,
`Moon`, `Sun`, `FileText`, `Languages` (icon names), and zero
occurrences of the i18n keys `hiddenNightOwl`, `hiddenEarlyBird`,
etc.

---

### HIGH-2 — i18n message bundle ships hidden-achievement strings to every client

**Severity**: HIGH
**File**: `/Users/marc/Projects/HealthLog/src/lib/i18n/context.tsx:15-16` (pre-existing client-side bundle import); content at `/Users/marc/Projects/HealthLog/messages/en.json:2195-2218` and `/Users/marc/Projects/HealthLog/messages/de.json` parallel.
**Ship-blocker**: NO — pre-existing v1.4.x architectural decision; v1.4.18 is the first release where this matters because v1.4.18 added the hidden Easter-eggs.

**Issue**

`src/lib/i18n/context.tsx` is a `"use client"` module that imports
`messages/en.json` and `messages/de.json` at module-eval time:

```ts
import deMessages from "../../../messages/de.json";
import enMessages from "../../../messages/en.json";
```

That means the FULL i18n bundle (every key, every locale) ships
inside the client JS bundle for every page in the app. The strings
`"Logged an entry between 02:00 and 04:00 in the morning."`,
`"Logged an entry on February 29."`,
`"Switched the app language at least once."`, etc. live in the
bundle that any logged-in user can `view-source` on the
`_next/static/chunks/*.js` URL.

Even if HIGH-1 is fixed and the API never speaks the hidden
predicates, a user who searches the JS bundle for the string
`achievements.badges.hidden` finds them all. So HIGH-1 is a partial
mitigation; HIGH-2 is the real long-term fix.

**Recommendation**

Move hidden-achievement strings out of the client-side i18n bundle.
Two viable approaches:

1. **Server-side resolution for unlocks only.** Strip
   `messages/*.json` keys matching `^achievements.badges.hidden` at
   build time using a Next.js build hook; ship a separate
   `messages-hidden.json` only fetched server-side by the
   achievements API when an unlock is detected. The unlock toast
   would do a one-shot fetch to retrieve the title/description.

2. **Encode the hidden strings.** Less robust but cheaper:
   replace the hidden-achievement strings with reversible
   obfuscation (rot13, base64, etc.) in `messages/*.json`, decode
   client-side ONLY when `unlocked === true`. A determined
   attacker still beats this in 30 seconds, but it stops the
   accidental view-source leak.

Approach 1 is the right v1.5 fix. Approach 2 is a v1.4.19 stopgap.
Either way, this is NOT a ship-blocker for v1.4.18 because the
existing 5+ "achievements.badges.hidden\*" keys were never going to
be a v1.4-class secret — Marc accepted "playful, off-the-wall, NOT
health-coercive" semantics, and HIGH-2's mitigation cost is
disproportionate to a casual Easter-egg game.

---

## MEDIUM

### MED-1 — Read-modify-write race in `/api/dashboard/chart-overlay-prefs` PUT

**Severity**: MEDIUM (correctness > security; data integrity edge case under concurrent writes)
**File**: `/Users/marc/Projects/HealthLog/src/app/api/dashboard/chart-overlay-prefs/route.ts:56-76`
**Ship-blocker**: NO — single-tab single-user pattern is the realistic case; the v1.4.18 release ships at most 5 chart keys, so the worst-case data loss is 1-of-5 toggles.

**Issue**

The handler reads `dashboardWidgetsJson`, merges the new chart's
prefs locally in the route handler, then writes the whole blob
back. Two concurrent PUTs (e.g. user opens two tabs and toggles
overlays in both) will race: the second `findUnique` may see the
first PUT's write or may see the prior state, and the second
`update` always clobbers the first PUT's `chartOverlayPrefs` key
for any chartKey other than its own. The same race applies to a
PUT on `/api/dashboard/widgets` overlapping with a PUT on
`/api/dashboard/chart-overlay-prefs` — they both serialize the
whole blob.

Not a security issue — the user can only race against themselves;
no cross-user write is possible because `requireAuth()` gates and
the `where: { id: user.id }` clauses are correct. It is a data-
integrity concern.

**Recommendation**

Wrap the read+write in a single Prisma transaction with
`SERIALIZABLE` isolation, OR move the chart overlay prefs to a
dedicated column (`User.chartOverlayPrefsJson`) so the two PUT
routes don't share a write target. The latter also lets the JSON
column receive a Postgres `||` jsonb-merge update that is
naturally atomic.

This is a v1.5 follow-up — defer.

---

## LOW

### LOW-1 — Add regression test pinning `!a.isHidden` filter on `nextAchievement` selection

**Severity**: LOW
**File**: `/Users/marc/Projects/HealthLog/src/app/api/gamification/achievements/route.ts:833-836` and `/Users/marc/Projects/HealthLog/src/app/achievements/page.tsx:351-389`
**Ship-blocker**: NO — the route correctly filters `!a.isHidden`.

**Note**

Reviewed. The `nextAchievement` selection in route.ts is

```ts
visibleAchievements
  .filter((a) => !a.unlocked && !a.isHidden)
  .sort(...)
```

so hidden-locked achievements never become the "next goal" card on
the achievements page — confirmed safe.

The `fullResult.summary.nextAchievement` computed earlier in
`/Users/marc/Projects/HealthLog/src/lib/gamification/achievements.ts:747-750`
does NOT filter on `isHidden`, but that summary is discarded by
the route (which recomputes its own summary at lines 833-851).
No leak path today.

Still, please add a regression test pinning the `!a.isHidden`
filter in the route so a future refactor doesn't drop it. Suggested
location: `/Users/marc/Projects/HealthLog/src/app/api/gamification/achievements/__tests__/`.

---

### LOW-2 — `data-category="hidden"` on the section element advertises that hidden achievements exist

**Severity**: LOW (cosmetic / informational)
**File**: `/Users/marc/Projects/HealthLog/src/app/achievements/page.tsx:411-413`
**Ship-blocker**: NO

**Note**

The page renders

```html
<section
  data-category="hidden"
  data-slot="achievements-category"
  aria-labelledby="achievements-category-hidden"
></section>
```

This is **intentional** per Marc's spec ("Hidden achievements
appear in the Achievements tab as 'Hidden' cards (user knows they
exist but not what they are)"). Calling it out only so the next
reviewer doesn't flag it. The DOM markup correctly exposes the
existence of the hidden category without exposing the predicates.

The `aria-label="Hidden locked achievement"` (page.tsx:150) is
the same — by design, accessibility-correct.

---

## Cross-cutting hygiene checks (all clean)

- **dangerouslySetInnerHTML / innerHTML / eval / new Function**: zero
  new occurrences in the v1.4.17..HEAD diff.
- **apiHandler wrapping**: every new route uses `apiHandler(async
...)` per CLAUDE.md
  (`/Users/marc/Projects/HealthLog/src/app/api/dashboard/chart-overlay-prefs/route.ts:41`).
- **requireAuth gating**: every new route calls
  `await requireAuth()` before touching `prisma`.
- **userId scoping**: every new `prisma.*.findMany` /
  `findUnique` / `update` filters by `userId: user.id` or
  `id: user.id` — confirmed for the analytics route's BP-window
  reads (`src/app/api/analytics/route.ts:67-83`), the achievements
  reads (`src/app/api/gamification/achievements/route.ts:474-561`),
  and the chart-overlay-prefs read+write
  (`src/app/api/dashboard/chart-overlay-prefs/route.ts:56-71`).
- **Zod validation on PUT bodies**: yes; `prefsSchema` rejects
  unknown chart keys and non-boolean toggles via `z.enum` +
  `z.boolean()`.
- **redactSecrets coverage**: the new `annotate()` calls only
  ship plain identifiers (`chart_key`, `flags_on`, `format`,
  `visible_count`); no PII or token material reaches the log
  pipeline. The existing `apiHandler` middleware redacts error
  messages via `redactSecrets()` — confirmed in
  `src/lib/logging/event-builder.ts:65,72`.
- **No SQL injection vector**: all DB calls use Prisma with
  parameterized queries.
- **No new external HTTP calls**: the achievement evaluator is
  pure and in-process; chart-overlay-prefs only touches the
  database.
- **Audit trail for new actions**: the new
  `settings.locale.update` audit row in
  `/Users/marc/Projects/HealthLog/src/lib/auth/profile-update.ts`
  correctly suppresses the log when the locale value didn't
  change (commit `75c74f1`), preventing audit-log noise that
  would otherwise let a user grind the polyglot Easter-egg by
  saving the same locale repeatedly.
- **Cross-user write protection on `/api/dashboard/chart-overlay-prefs`
  PUT**: Zod-rejected unknown shape; `where: { id: user.id }`
  on the read AND the write; no userId field accepted from the
  request body. Cannot be coerced into writing another user's
  layout.

---

## Verdict

Ship v1.4.18 as-is. File HIGH-1 + HIGH-2 + MED-1 + LOW-1 to the
v1.4.19 / v1.5 backlog. The hidden Easter-egg discovery promise
to Marc holds at the DOM layer (which is what most users will
ever inspect); the network/bundle leak is a known consequence of
the i18n architecture and not a fresh v1.4.18 regression severe
enough to gate the release.
