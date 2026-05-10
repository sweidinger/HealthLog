# Wave 3 — Coach polish report (v1.4.22)

Adopts the W1b research output: the Coach now talks like a partner
who sits alongside the user, not a database cursor. Load-bearing
numbers move out of the prose into a collapsible block at the bottom
of every assistant turn. Five atomic commits on `origin/develop`.

## Commits

1. `feat(coach): warm motivational rewrite with evidence-block sentinel`
   — system-prompt EN + DE rewrite, PROMPT_VERSION 4.20.2 → 4.22.0,
   broadens schema-test regex off the 4.20.x pin.
2. `feat(coach): parse evidence-block sentinel out of streamed prose`
   — `---KEYVALUES---` … `---END---` parser, `CoachProvenance.keyValues`
   extension, route + persistence + SSE provenance frame wiring,
   integration coverage.
3. `feat(coach): collapsible evidence-block disclosure under assistant
   bubbles` — `<details>` disclosure with chevron in
   `message-thread.tsx`; closed by default; hides when keyValues is
   empty; both EN + DE labels.
4. `refactor(coach): drawer polish — Gravatar avatar, disclaimer
   move, cog removal` — user bubble pulls `useAuth().user.gravatarUrl`
   at the same 32-px dimensions as the Coach avatar with initials
   fallback; disclaimer moved out of `coach-input.tsx` into
   `sources-rail.tsx`'s footer; settings cog removed cleanly from the
   drawer header.
5. `chore(planning): record Wave 3 Coach polish completion` — STATE
   tick + this report.

## Sentinel-parse design

Wave 3 ships a text-marker sentinel (`---KEYVALUES---` … `---END---`)
with line-formatted entries (`<label>: <value> [<unit>] (<window>)`)
rather than the fenced-JSON shape W1b sketched. The maintainer
called this directly — robust against accidental Markdown-render
collisions, and easier to scan in raw provider logs.

Hard caps stack three ways:

- 1 KB on the sentinel-block payload (post-`---KEYVALUES---` byte
  count). Prompt-injection padding cannot grow the persisted
  envelope.
- 8 lines kept after parsing — matches the prompt contract.
- Each line validates against the Zod `coachKeyValueSchema`
  (length-capped label / value / unit / window). Malformed lines
  drop silently; the route logs a wide-event
  `coach.keyvalues.parse_failed` only when the block as a whole is
  malformed (missing close sentinel, truncated, or zero valid rows).

When the provider returns prose-only (mock client, refusal path,
legacy provider that hasn't been re-prompted), the parser is a
no-op: prose passes through, no `keyValues` field lands on the
persisted envelope, and the UI hides the disclosure entirely.

## Settings cog

Removed per the maintainer's directive. The placeholder tooltip
("Coach settings arrive in v1.4.21") read as a dead button after
v1.4.21 shipped without delivering that surface. The v1.4.23
candidate is a per-user prompt-tuning panel (tone, verbosity,
fallback-language preference) — when that's ready, the cog returns
with real wiring.

## Concrete prose example

User asks: "Meinst du, ich sollte mehr Sport machen?"

The new prompt produces (synthesised from the prompt's rules + the
embedded few-shot):

> Bewegung sehe ich in deinem Tracking gerade nicht — magst du mir
> kurz erzählen, wie eine typische Woche bei dir aussieht?
> Spaziergänge, Sport, irgendwas Strukturierteres? Dann schauen wir
> gemeinsam mit dem, was ich sehe, ob mehr Sport gerade Sinn ergibt.

No sentinel block (the turn is qualitative, no numbers carry the
answer), so the disclosure is hidden client-side. The persona
("warm, neugierig, zurückhaltend"), the rule-3 invitation pivot, and
the rule-5 open question all fire in three sentences.

## Test count delta

- Unit tests: 2068 → 2085 (+17 — 14 system-prompt assertions, 18
  sentinel-parse cases, 4 message-thread disclosure + Gravatar
  cases; offset against the disclaimer-test rewrite in coach-input
  and sources-rail).
- Integration tests: 5 → 7 (+2 — sentinel round-trip + prose-only
  graceful-degrade against the postgres testcontainer).

## Verification gates

- `pnpm typecheck` — clean.
- `pnpm lint` — 13 pre-existing warnings (no new entries).
- `pnpm test --run` — 241 files / 2085 tests green.
- `pnpm test:integration tests/integration/coach-chat.test.ts` —
  7 tests green.

## What did not ship

Nothing was punted from the Wave 3 scope. The B3 Gravatar parity
uses initials when the user's email is missing — the lookup is
already server-side in `/api/auth/me`, so there's no extra round
trip on the client. The Coach drawer mobile-tray test was untouched
and still passes after the cog removal.

## What stays as Wave 3 followups

- v1.4.23 candidate: per-user Coach settings surface (tone slider,
  language preference). Brings the cog back with real wiring.
- The `mock-client.ts` provider remains prose-only by design — no
  changes needed.
- Sentinel format is documented in the prompt body itself; a
  future docs-site page on the v1.4.22 release covers the
  user-facing disclosure.
