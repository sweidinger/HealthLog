# Phase B2b — AI Coach drawer UI

Date: 2026-05-10
Status: complete
Branch: `develop`

The B2b half of v1.4.20 wave B ships the drawer UI on top of the B2a
backend: TanStack Query data hooks, SSE streaming client, drawer
shell, message thread, source chips, composer, history rail, sources
rail, and the `/insights` wiring that opens the drawer from the hero
strip's "Ask the coach" button + suggested-prompt chips.

## Commit timeline (four atomic commits + this report on `develop`)

| SHA | Subject |
| --- | --- |
| `c42c0a5` | `feat(coach): TanStack Query hooks + SSE streaming client` |
| `195448a` | `feat(coach): drawer shell, message thread, source chips` |
| `8dac389` | `feat(coach): composer, history rail, sources rail` |
| `e541799` | `feat(insights): wire Coach drawer into /insights via hero strip` |
| _(this)_  | `docs(planning): tick B2b complete, record phase-B2b report` |

## Streaming implementation

`useSendCoachMessage()` POSTs the body to `/api/insights/chat` with
`Accept: text/event-stream` and reads the response via
`response.body.getReader()` + `TextDecoder`. Decoded chunks are
fed into a pure `parseSseChunk(buffer, chunk)` helper that splits on
the `\n\n` frame separator, strips the `data: ` prefix, JSON-parses
the payload, and returns `{ events, rest }`. The hook accumulates
tokens into `streaming.content`, attaches the `provenance` envelope
to `streaming.metricSource`, captures the resolved `conversationId` on
the `done` frame, and surfaces an `errorCode` on the `error` frame. On
success it invalidates the rail + the just-completed conversation
cache so the drawer's next mount sees the canonical persisted shape
(matching the queryKey pattern in `src/lib/query-keys.ts`).

`parseSseChunk` is exported as a separate symbol so the parser is
unit-testable without spinning up a live network stream — the test
suite covers single-frame, multi-frame, byte-by-byte interleaving,
malformed-payload tolerance, and the full token + provenance + done
round-trip.

## Component map

```
src/components/insights/coach-panel/
├── use-coach.ts            ← TanStack Query hooks + SSE client +
│                             parseSseChunk()
├── coach-drawer.tsx        ← <Sheet side="right"> wrapper, 3-col grid
├── message-thread.tsx      ← user / assistant bubble renderer +
│                             pinned-to-bottom auto-scroll
├── source-chips.tsx        ← provenance row (labels-only)
├── coach-input.tsx         ← composer (textarea + mic + send +
│                             disclaimer)
├── history-rail.tsx        ← conversation list + filter + delete
├── sources-rail.tsx        ← "What I can see" — 5 metric contracts
└── __tests__/
    ├── use-coach.test.ts        (11)
    ├── source-chips.test.tsx    (7)
    ├── message-thread.test.tsx  (8)
    ├── coach-input.test.tsx     (10)
    ├── history-rail.test.tsx    (7)
    └── sources-rail.test.tsx    (5)
```

The drawer accepts slot props (`historyRail`, `sourcesRail`,
`composer`) so future tests / storybooks can swap individual columns
without coupling them to the shell. In production the drawer mounts
the defaults so callers only need to pass `open` + `onOpenChange` +
`prefill`.

## Wiring at `/insights`

`src/app/insights/page.tsx` owns `coachOpen` + `coachPrefill` state.

- `<HeroStrip>` gains an `onAskCoach` prop. When passed, the "Ask the
  coach" button drops the disabled state + Coming-soon tooltip and
  clicking sets `coachOpen=true` with `prefill=null`.
- `<HeroStrip>`'s `onPickPrompt` (already wired in B1) now sets
  `coachPrefill=<chip>` and `coachOpen=true` so a chip click pops the
  drawer with the localised prompt already in the composer.
- `<CoachDrawer>` mounts at the bottom with `key={prefill ?? "blank"}`
  so the lazy `useState` initialiser fires fresh on every chip
  transition and the composer surfaces the latest prefill — this
  sidesteps the `react-hooks/set-state-in-effect` rule (no
  `setState` inside `useEffect`).

## Test coverage

| Suite | Before | After | Δ |
| --- | --- | --- | --- |
| Unit (vitest) | 1781 | 1833 | +52 |
| Integration | 78 | 78 | 0 |

Six new test files cover the streaming parser, every drawer column,
the message thread state machine, locale-aware labels, and the
hero-strip handler wiring inside `/insights`. The integration suite
is unchanged because the drawer adds no new server-side behaviour.

## i18n

New strings under `insights.coach.*`:

- Drawer chrome: `tagline`, `newChat`, `settings`, `settingsTooltip`,
  `send`, `thinking`, `composerPlaceholder`, `composerHint`,
  `composerDisclaimer`, `voiceComingSoon`, `threadEmpty`
- History rail: `historyTitle`, `historySearchPlaceholder`,
  `historyEmpty`, `historyDeleteAria`, `historyDeleteConfirm`
- Sources rail: `sourcesTitle`, `sourcesFresh`, `sourcesStale`,
  `sourcesFooter`
- Provenance chip namespaces: `metric.{bp,weight,pulse,mood,
  compliance,general}` and `window.{last7days,last30days,last90days,
  allTime}`

Both `messages/en.json` and `messages/de.json` updated;
`i18n-locale-integrity.test.ts` keeps passing.

## Pieces deferred (handed off, not blocking)

- **Voice input** → v1.5 paired with the iOS app. The mic button
  renders disabled with a tooltip pointing at the v1.5 release; the
  PWA is the wrong shipper for voice.
- **Chart-in-message** → B3. Source chips today are visual-only; once
  the trends row + correlation row land, a chip click can deeplink to
  the relevant chart with the matching window pre-selected.
- **Full-page `/insights/coach` route** → v1.5. The drawer covers the
  v1.4.20 use case; the dedicated route is a better fit once the iOS
  app needs a deep-link target.
- **Mobile rail trays** → v1.4.21. On `<lg` the drawer collapses to a
  single column with the message thread visible; the history +
  sources rails are reachable via a dropdown menu in a follow-up.
- **`<IntegrationStatusPill>` integration in sources rail** →
  v1.4.21. Today the rail shows static green dots; the next round
  reuses the existing pill so the user sees fresh / stale state.

## UX decisions that may need maintainer review

- **Drawer width on `lg+` is `1080px`.** The artboard reads tighter
  but the three-column layout (260 + auto + 280) gets cramped under
  900 px. If this feels too wide the call is to drop the sources rail
  on `lg` and only show it on `xl+`.
- **Plain Enter sends the message.** The artboard prototype shows
  ⌘↵ as the explicit affordance with `Enter` left for newlines. We
  ship plain-Enter sends (Shift+Enter for newline) because the
  composer is short by design (~80–220 word replies) and parity with
  ChatGPT / Linear AI is the prevailing pattern. Easy to flip if
  Marc disagrees.
- **Confirm-then-go delete.** The first click on the delete trash
  flips the icon red; a second click commits the optimistic remove
  with rollback. No modal. If the maintainer wants an explicit
  `<AlertDialog>` we have one in `src/components/ui/`.
- **Streaming bubble pulse.** The in-flight assistant bubble pulses
  via `animate-pulse` (opacity-only). The artboard shows shimmer; the
  app's existing skeletons use pulse, so we follow the codebase
  rather than the artboard for visual identity.

## Voice / hygiene

- No maintainer-name leaks in committed source.
- All UI-rendered strings live in `messages/{en,de}.json`.
- Co-Author trailer present on every commit; pre-commit hooks ran
  green; no `--no-verify` or `--no-gpg-sign` used.

## Verification gate snapshot

```
pnpm typecheck       0 errors
pnpm lint            0 errors / 12 baseline warnings (unchanged)
pnpm test --run      223 files, 1833 passed
```
