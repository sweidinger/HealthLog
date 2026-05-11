# Phase B2a — AI Coach backend

Date: 2026-05-10
Status: complete
Branch: `develop`

The B2a half of v1.4.20 wave B ships the AI Coach backend: Prisma
schema, encrypted persistence, SSE streaming endpoint, token-budget
ledger, prompt-injection + off-topic refusal, and conversation-rail
endpoints. The drawer UI (B2b) dispatches separately.

## Commit timeline (five atomic commits on `develop`)

| SHA       | Subject                                                               |
| --------- | --------------------------------------------------------------------- |
| `5527001` | `feat(coach): add CoachConversation, CoachMessage, CoachUsage models` |
| `a68557d` | `feat(coach): types, persistence, budget, and refusal helpers`        |
| `16f3ece` | `feat(coach): add POST /api/insights/chat SSE streaming endpoint`     |
| `3168ba8` | `feat(coach): GET list, GET single, DELETE conversation endpoints`    |
| _(this)_  | `docs(planning): tick B2a complete, record phase-B2a report`          |

## Schema + migration

`prisma/migrations/0035_coach_conversations_v1420/migration.sql` adds
three tables:

- `coach_conversations` — one row per chat thread, owned by a user.
  `title` is a plain-text snippet (≤80 chars) of the first user
  message so the rail can render without paying the per-message
  decrypt cost.
- `coach_messages` — `encrypted_content` is the AES-256-GCM payload
  written via `src/lib/crypto.ts` under the active `ENCRYPTION_KEYS`
  entry. Key rotation works the same way as for the existing
  encrypted columns. `metric_source_json` is plain text on disk and
  carries label-only provenance (window names, metric tags, sample
  counts) — never raw values.
- `coach_usage` — per-(user, UTC-day) token ledger. Unique index on
  `(user_id, date_key)` lets the dispatcher upsert the day's row
  without read-modify-write contention.

GDPR cascade is wired through the FK chain so user deletion drops
every Coach row.

## Helpers

- `src/lib/ai/coach/types.ts` — chat-request zod schema, SSE event
  shapes (`token`, `provenance`, `done`, `error`), DTOs.
- `src/lib/ai/coach/persistence.ts` — encrypt-on-write / decrypt-on-
  read helpers, `summariseTitle()` for the rail, cursor-paginated
  `listConversations()`, `deleteConversation()` with ownership check.
- `src/lib/ai/coach/budget.ts` — `MAX_TOKENS_PER_USER_PER_DAY = 25
000`. UTC `dateKey` so the meter aligns with the LLM provider's
  billing boundary. `enforceBudget()` throws `HttpError(429,
"coach.budget.exceeded")`. `recordSpend()` clamps non-finite token
  figures to 0 so a misbehaving provider can't poison the ledger.
- `src/lib/ai/coach/refusal.ts` — pattern-based detector for prompt
  injection (EN + DE wording, jailbreak variants, "reveal your
  system prompt", `system:` impersonation) and obvious off-topic
  asks (weather, code, recipes). A health-allow list short-circuits
  the deny list when the message mixes a health term with an
  off-topic word.
- `src/lib/ai/coach/system-prompt.ts` — Coach-specific prompt that
  reuses the v1.4.20 PROMPT_VERSION and ground-rule rules but in
  conversational tone (no JSON, ~80–220 words, "consult your
  doctor" footer on actionable replies).
- `src/lib/ai/coach/snapshot.ts` — reuses `extractFeatures()` so
  the Coach narrates the same numbers the dashboard tiles render.
  Returns the JSON snapshot **and** the provenance envelope built
  from the windows + metrics actually present.

## Routes

- `POST /api/insights/chat` — SSE streaming. Cookie or bearer auth.
  Validates body, enforces budget, runs refusal scanner, walks
  provider chain, persists user + assistant turns, increments
  `CoachUsage`. Idempotency wrap applies only when no
  `conversationId` is supplied (= a brand-new conversation). The
  response is one `token` frame per word-sized chunk, then a
  `provenance` frame, then `done`. Provider-chain failure emits an
  `error` frame and does NOT persist an assistant message.
- `GET /api/insights/chat` — cursor-paginated list (default limit
  20, hard cap 50). Returns `{ conversations, nextCursor }`.
- `GET /api/insights/chat/[id]` — fetch one conversation with every
  message decrypted on the fly. 404 (not 403) on cross-user lookup.
- `DELETE /api/insights/chat/[id]` — hard-delete; FK chain cascades
  the messages. 404 on cross-user.

## Test coverage

| Suite         | Before | After | Δ   |
| ------------- | ------ | ----- | --- |
| Unit (vitest) | 1753   | 1781  | +28 |
| Integration   | 67     | 78    | +11 |

Unit tests cover refusal patterns (13 cases), title summarisation (6),
and budget guard semantics (9). Integration tests pin five chat-route
scenarios (refusal, round-trip with encrypted persistence, budget
429, foreign-conversation 404, validation 422) and six conversation-
endpoint scenarios (list ordering, owner-only filter, decryption
round-trip, 404 boundary on GET single, delete with cascade, 404
boundary on DELETE).

## Token-budget default — rationale

`MAX_TOKENS_PER_USER_PER_DAY = 25 000` chosen as a conservative cap:

- One assistant turn at ~600 tokens output + ~1 200 tokens input
  (system prompt + snapshot + 19 turns of history) = ~1 800 tokens.
- 25 000 tokens / 1 800 ≈ 13 turns/day for a heavy user.
- A typical Insight-generation reply runs ~1 500 tokens; 25 000 is
  still cheap on the operator's budget at scale.

UTC-aligned to the LLM provider billing boundary so reasoning about
overnight rollover stays trivial. Operators can dial the cap via a
future env override (out of scope for B2a; tracked in v1.4.21
backlog).

## Provenance JSON schema (one paragraph)

`metricSourceJson` stores the assistant's source-chip envelope as a
small JSON object: `windows` is an array of the analytic windows the
snapshot block covered (subset of `last7days`, `last30days`,
`last90days`, `allTime`); `metrics` is an array of stable contract
keys (`bp`, `weight`, `pulse`, `mood`, `compliance`, or the catch-
all `general` when no metric data was present); `counts` is an
optional partial map from metric key to sample count. Labels only —
never raw values, never timestamps — so the column stays queryable
without the encryption key for future analytics.

## Flagged-uncertain items (handed off, not blocking)

- The "summarise older half" pass is currently a placeholder (the
  history-window builder injects a synthetic `[summary placeholder
— N earlier turns elided]` line rather than calling a provider to
  produce a real summary). Cheap and deterministic; an opt-in real-
  summarisation pass can land alongside B2b once the drawer UI shows
  whether users actually push past 20 turns.
- The Coach inherits the existing rate-limit-free posture for
  authenticated routes. Burst protection rides on the per-day token
  ledger only. If the drawer UI exposes a "regenerate" button we
  may want a per-minute floor on top.
- `coach.error*` i18n keys are wired but the route currently
  surfaces the JSON code rather than the localised string in the
  error envelope; B2b can swap to localised copy in the SSE error
  frame's `message` field once the UI wants to render it without a
  separate translator round-trip.

## Voice / hygiene

- No maintainer-name leaks in committed source.
- All UI-rendered strings (refusal copy, error labels) live in
  `messages/{en,de}.json` under `insights.coach.*`.
- Co-Author trailer present on every commit; pre-commit hooks ran
  green; no `--no-verify` or `--no-gpg-sign` used.

## Verification gate snapshot

```
pnpm typecheck       0 errors
pnpm lint            0 errors / 12 baseline warnings (unchanged)
pnpm test --run      217 files, 1781 passed
pnpm test:integration 20 files,  78 passed
```
