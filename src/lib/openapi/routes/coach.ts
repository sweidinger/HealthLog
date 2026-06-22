/**
 * OpenAPI route table — insights layout, coach facts, about-me, chat message feedback.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 * Schemas come from `src/lib/validations/*` where shared with the
 * runtime request parsing, so the wire contract stays single-source.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";
import { aboutMePutSchema } from "@/lib/validations/about-me";
import {
  ACCEPTED_INSIGHTS_TILE_IDS,
  INSIGHTS_SECTION_IDS,
} from "@/lib/insights-layout";
import { COACH_FACT_CATEGORIES } from "@/lib/ai/coach/facts";
import { coachChatRequestSchema } from "@/lib/ai/coach/types";
import { exportSelectionSchema } from "@/lib/validations/health-record-export";
import { createShareLinkSchema } from "@/lib/validations/clinician-share-link";
import { coachReminderSuggestionActionSchema } from "@/lib/validations/coach-reminder-suggestion";
import { dataEnvelope, errorEnvelope, stdResponses } from "./shared";

// ── Coach cadence suggestions (v1.18.1) ──────────────────────────────
// The action endpoint behind the one-tap reminder-suggestion card. The
// client sends ONLY the cadence id + the action; the server resolves the
// metric + schedule + course window from the closed catalog and (for
// `accept`) mints a `MeasurementReminder` with `origin: COACH`.
coachReminderSuggestionActionSchema.meta({
  id: "CoachReminderSuggestionAction",
  description:
    "v1.18.1 — act on a Coach cadence suggestion. `cadenceId` names a closed-catalog preset (e.g. `weight_daily`, `bp_7_2_2`); the client never sends a schedule. `action`: `accept` creates a `MeasurementReminder` (origin: COACH) through the same engine the Vorsorge surface uses; `dismiss` records dismissal memory; `stop` suppresses all future cadence suggestions. Strict: unknown keys 422.",
});

const coachReminderSuggestionResultSchema = z
  .object({
    ok: z.literal(true),
    action: z.enum(["accept", "dismiss", "stop"]),
    reminder: z
      .unknown()
      .nullable()
      .optional()
      .describe(
        "On `accept` of a fresh suggestion: the created MeasurementReminder DTO. Null when the action was a prefs-only dismiss/stop, or when an accept hit the structural dedup (`duplicate: true`).",
      ),
    duplicate: z
      .boolean()
      .optional()
      .describe(
        "True when an `accept` matched an already-live COACH reminder for the same metric (idempotent no-op).",
      ),
  })
  .meta({
    id: "CoachReminderSuggestionResult",
    description:
      "Outcome of a Coach cadence-suggestion action. `accept` returns 201 with the created reminder (or 200 + `duplicate: true` when one already exists); `dismiss`/`stop` return 200.",
  });

export const coachReminderSuggestionPaths: NonNullable<
  ZodOpenApiObject["paths"]
> = {
  "/api/coach/reminder-suggestions": {
    post: {
      tags: ["Insights"],
      summary: "Act on a Coach cadence suggestion",
      description:
        'v1.18.1 — accept / dismiss / stop a Coach-proposed measurement cadence. Coach-gated (`requireModuleEnabled("coach")`); a disabled surface 403s. `accept` resolves the cadence from the closed server-side catalog and creates a `MeasurementReminder` with `origin: COACH` (201), or returns 200 with `duplicate: true` when a live COACH reminder for that metric already exists — idempotent against a re-tapped or stale card, with a partial unique index as the structural backstop. Per-user rate-limited (429 on excess). Auth via cookie or Bearer; the owner is narrowed from the session.',
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: coachReminderSuggestionActionSchema },
        },
      },
      responses: {
        "200": {
          description:
            "A dismiss/stop, or an accept that matched an existing reminder (`duplicate: true`).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                coachReminderSuggestionResultSchema,
                "CoachReminderSuggestionResultOk",
              ),
            },
          },
        },
        "201": {
          description: "An accept that created a new reminder.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                coachReminderSuggestionResultSchema,
                "CoachReminderSuggestionResultCreated",
              ),
            },
          },
        },
        "403": {
          description: "Coach surface (or the cadence's module) disabled.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        // 401 / 422 / 429 come from stdResponses.
        ...stdResponses,
      },
    },
  },
};

const coachMessageFeedbackBody = z
  .object({
    rating: z.enum(["helpful", "unhelpful"]),
    reason: z.string().min(1).max(200).optional(),
  })
  .meta({
    id: "CoachMessageFeedbackRequest",
    description:
      "Per-message helpful/unhelpful feedback (v1.4.23 H7). Optional `reason` is free-form prose, capped at 200 chars.",
  });

// Insights tile layout — mirrors the Zod schema in
// `src/app/api/insights/layout/route.ts`. The tile-id enum is derived
// from the same `ACCEPTED_INSIGHTS_TILE_IDS` source so the contract
// cannot drift.
//
// v1.8.0 — the canonical ids are English (`blood-pressure`, `pulse`,
// `oxygen`, `body-temperature`, `weight`, `active-energy`, `sleep`,
// `resting-pulse`, `mood`, `medications`). The endpoint still ACCEPTS
// the legacy German ids (`blutdruck`, `puls`, `sauerstoff`,
// `koerpertemperatur`, `gewicht`, `aktive-energie`, `schlaf`,
// `ruhepuls`, `stimmung`, `medikamente`) on input so existing iOS
// layouts keep validating; the server normalises them to the canonical
// English id before persisting, and GET always returns canonical ids.
// The legacy ids are accepted-but-deprecated and will be dropped from
// the accepted set in a future major.
// v1.15.11 — layout v2 adds an optional `sections` array on top of the
// per-metric `tiles` list so the overview's big semantic blocks can be
// reordered/hidden in their own right. `sections` is additive and
// optional: a client PUTting only `tiles` (the pre-v2 iOS contract) still
// validates, and a v1 blob resolves forward to a valid v2 layout with all
// sections default-visible. Section ids are English from birth — no
// legacy-alias widening. `tiles` is likewise optional now (a section-only
// PUT fills the default tile set), but must carry at least one entry when
// present.
const insightsLayoutSchema = z
  .object({
    // v1.15.11 QA C1 — both v1 and v2 are accepted on input. The live iOS
    // client still PUTs `version: 1`; the server normalises to the canonical
    // v2 blob on persist, so a v1 body never 422s on the layout-schema bump.
    version: z.union([z.literal(1), z.literal(2)]),
    sections: z
      .array(
        z.object({
          id: z.enum(INSIGHTS_SECTION_IDS),
          visible: z.boolean(),
          order: z.number().int().min(0).max(99),
        }),
      )
      .max(50)
      .optional(),
    tiles: z
      .array(
        z.object({
          id: z.enum(ACCEPTED_INSIGHTS_TILE_IDS),
          visible: z.boolean(),
          order: z.number().int().min(0).max(99),
        }),
      )
      .min(1)
      .max(50)
      .optional(),
  })
  .meta({
    id: "InsightsLayoutBody",
    description:
      "Per-user Insights layout (v2). `tiles` is the per-metric pill list (ordered, with a visibility flag); `sections` is the additive v2 list of the overview's big semantic blocks (wellness-scores, daily-briefing, vitals, trends, period-review, cycle-summary, signals, rhythm-events), each with order + visibility. `version` is the layout schema version: BOTH 1 and 2 are accepted on input (a pre-v2 iOS client still PUTs `version: 1`); the server always normalises to the canonical v2 blob before persisting, and GET responses always carry `version: 2`. Both arrays are optional on input — a client sending only `tiles` (the pre-v2 contract) still validates, and the server fills missing defaults; a v1 blob with no `sections` resolves forward with all sections default-visible. Tile ids are a closed enum: the canonical ids are English (matching the routed `/insights/<slug>` sub-pages). The legacy German tile ids (blutdruck, puls, sauerstoff, koerpertemperatur, gewicht, aktive-energie, schlaf, ruhepuls, stimmung, medikamente) remain accepted on input for backward compatibility and are normalised to their English equivalents before persisting; GET responses always carry the canonical English ids. Section ids are English-only. The legacy tile ids are deprecated and will be removed in a future major version.",
  });

// v1.7.0 — health-record export selection. Strict shape: unknown keys
// (including any attempt to smuggle a userId) 422 via returnAllZodIssues.
// v1.11.0 — clinician share-link create payload. Strict; no `userId` field
// (the owner is always narrowed from the session/Bearer). `expiresAt` is
// required and capped at SHARE_LINK_MAX_DAYS; the scope columns are frozen
// write-once at creation.
createShareLinkSchema.meta({
  id: "CreateShareLinkRequest",
  description:
    "v1.11.0 — owner request to mint a clinician share link to their own health record. `expiresAt` is required (absolute ISO instant) and capped at 90 days. `rangeStart`/`rangeEnd` freeze the reporting window (rangeEnd null = rolling). `resourceTypes` scopes the FHIR resources the link may serve; `allowFhirApi` toggles REST reachability. Strict: unknown keys 422.",
});

exportSelectionSchema.meta({
  id: "HealthRecordExportRequest",
  description:
    "v1.7.0 — health-record / doctor-handover export selection. `format` picks PDF, FHIR R4 document Bundle, or a combined zip package. Grouped `sections` toggles drive which domains are read (mood is opt-in, off by default). No `userId` field — the user is always narrowed from the session/Bearer. The route is strict: unknown keys 422.",
});

// ── Coach facts (v1.11.1) ────────────────────────────────────────────
// Read + delete surface for the durable facts the Coach extracts. Facts
// are server-extracted, not user-authored, so there is no create/update
// shape — only list, bulk-clear, and single-delete responses.

const coachFactItem = z.object({
  id: z.string(),
  category: z
    .enum(COACH_FACT_CATEGORIES)
    .describe(
      "App-side closed category: preference | condition | goal | constraint | context.",
    ),
  text: z.string().describe("Decrypted fact text."),
  confidence: z
    .number()
    .int()
    .describe("0..100 server-assigned extraction confidence."),
  createdAt: z.iso.datetime({ offset: true }),
});

const coachFactsListResponse = z.object({
  facts: z
    .array(coachFactItem)
    .describe(
      "The caller's active facts, highest-confidence then newest first. Undecryptable rows are omitted.",
    ),
});

const coachFactsClearedResponse = z.object({
  cleared: z
    .number()
    .int()
    .describe("Number of active facts soft-deleted by the bulk clear."),
});

const coachFactDeletedResponse = z.object({
  deleted: z
    .boolean()
    .describe(
      "True when a fact owned by the caller was soft-deleted; false for an unknown / cross-user / already-deleted id (idempotent no-op).",
    ),
});

// ── Coach conversation history (v1.18.0) ─────────────────────────────
// List + detail + delete surface for the Coach's persisted chat
// conversations. Bodies are stored encrypted at rest; the detail
// endpoint decrypts every message server-side, so the client never
// handles a key. The list endpoint stays metadata-only (no decryption).

const coachProvenanceSchema = z
  .object({
    windows: z
      .array(
        z.enum([
          "last7days",
          "last30days",
          "last90days",
          "lastYear",
          "allTime",
        ]),
      )
      .describe("Analysis windows the assistant drew on this turn."),
    metrics: z
      .array(z.string())
      .describe(
        "Stable metric-topic keys referenced (e.g. bp, weight, sleep, glucose). `general` is the empty-snapshot sentinel. The client translates these labels; the server never localises them.",
      ),
    counts: z
      .record(z.string(), z.number().int())
      .optional()
      .describe(
        "Per-metric sample-count summary; absent on an empty snapshot.",
      ),
    keyValues: z
      .array(
        z.object({
          label: z.string(),
          value: z.string(),
          unit: z.string().optional(),
          window: z.string().optional(),
        }),
      )
      .optional()
      .describe(
        "Load-bearing numbers the assistant surfaced, rendered in the collapsible evidence block. Hard-capped at 8 entries.",
      ),
    toolCalls: z
      .array(
        z.object({
          name: z.string(),
          present: z.boolean(),
        }),
      )
      .optional()
      .describe(
        "v1.20.0 — the retrieval-tool trace for this turn: which tools the Coach called and whether each found data. Metadata only (no values). Absent on the legacy snapshot path and on turns that called no tools.",
      ),
  })
  .meta({
    id: "CoachProvenance",
    description:
      "Provenance envelope attached to an assistant message — labels and counts only, plus the optional evidence key-values. No raw timestamps.",
  });

const coachMessageSchema = z
  .object({
    id: z.string(),
    role: z.enum(["user", "assistant"]),
    content: z
      .string()
      .describe("Decrypted message body — the server decrypts on read."),
    createdAt: z.iso.datetime({ offset: true }),
    metricSource: coachProvenanceSchema
      .nullable()
      .describe("Provenance envelope (assistant turns); null for user turns."),
    providerType: z
      .string()
      .nullable()
      .describe(
        "Provider that produced the reply (e.g. anthropic, openai, local, refusal); null for user turns.",
      ),
    promptVersion: z
      .string()
      .nullable()
      .describe(
        "Coach prompt version that produced the reply; null for user turns.",
      ),
    tokensUsed: z
      .number()
      .int()
      .nullable()
      .describe(
        "v1.18.9 — total tokens this assistant turn cost, persisted so the per-message token footer survives a reload. Null on user turns, refusals, and pre-feature rows.",
      ),
    model: z
      .string()
      .nullable()
      .describe(
        "v1.18.9 — the provider model that produced the reply (e.g. gpt-4o). Null when unknown (user turns, refusals, older rows).",
      ),
  })
  .meta({
    id: "CoachMessage",
    description:
      "One Coach chat message, decrypted server-side. Ordered oldest-first within a conversation.",
  });

const coachConversationSchema = z
  .object({
    id: z.string(),
    title: z.string().describe("Title summarised from the first user message."),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso
      .datetime({ offset: true })
      .describe("Bumped on every appended message; the rail orders by this."),
    messageCount: z.number().int(),
  })
  .meta({
    id: "CoachConversation",
    description:
      "Lightweight conversation metadata for the history rail. No message bodies — the rail does not decrypt.",
  });

const coachConversationsPageSchema = z
  .object({
    conversations: z.array(coachConversationSchema),
    nextCursor: z
      .string()
      .nullable()
      .describe(
        "Id of the last conversation on this page; pass it back as `cursor` for the next page. Null at the end of the list.",
      ),
  })
  .meta({
    id: "CoachConversationsPage",
    description:
      "Cursor-paginated page of the caller's Coach conversations, most-recent activity first.",
  });

const coachConversationDetailSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    messageCount: z.number().int(),
    messages: z
      .array(coachMessageSchema)
      .describe("Every message in the conversation, decrypted, oldest-first."),
    summary: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Rolling summary of turns elided past the history window; null when none is on file.",
      ),
  })
  .meta({
    id: "CoachConversationDetail",
    description:
      "Full conversation with every message decrypted server-side. The client renders the bodies directly; no decryption key is involved.",
  });

const coachConversationDeletedResponse = z.object({
  deleted: z
    .literal(true)
    .describe("Always true on success; a foreign / unknown id is a 404."),
});

coachChatRequestSchema.meta({
  id: "CoachChatRequest",
  description:
    "Inbound Coach turn. `message` is the user's turn (1–4 000 chars). `conversationId` is omitted to start a new conversation (the server mints a title from the first message) and supplied to continue one. `scope` narrows which metrics the snapshot ships and which window the timeline covers; omitted fields fall back to server defaults. `locale` picks the reply language. `guidedQuestion` carries the clarifying question a message answers (client-side bubble, never persisted). No `userId` field — the owner is narrowed from the session / Bearer.",
});

export const coachPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/insights/chat": {
    get: {
      tags: ["Insights"],
      summary: "List the caller's Coach conversations",
      description:
        'v1.18.0 — cursor-paginated list of the caller\'s Coach conversations for the history rail, most-recent activity first. Metadata only (id, title, timestamps, message count); message bodies are not decrypted here. `limit` defaults to 20, capped at 50; pass the returned `nextCursor` back as `cursor` for the next page (null at the end). Coach-gated (`requireAssistantSurface("coach")`); a disabled surface 403s. Auth via cookie or Bearer; the owner is narrowed from the session.',
      parameters: [
        {
          name: "cursor",
          in: "query",
          required: false,
          schema: { type: "string" },
          description:
            "Id of the last conversation on the previous page. Omit for the first page.",
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
          description: "Page size. Defaults to 20, capped at 50.",
        },
      ],
      responses: {
        "200": {
          description: "A page of the caller's conversations.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                coachConversationsPageSchema,
                "CoachConversationsPageResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    post: {
      tags: ["Insights"],
      summary: "Send a Coach turn (streaming reply)",
      description:
        "v1.18.0 — sends a user turn and streams the assistant reply as Server-Sent Events. The response is `text/event-stream`, not JSON: one `data: <json>\\n\\n` frame per event. Frame `type` is one of `token` (a chunk of reply text: `{ type, token }`), `provenance` (the evidence envelope: `{ type, metricSource }`), `suggestion` (a cadence-suggestion card: `{ type, suggestion }`), `reasoning` (v1.18.9, optional reasoning-summary text: `{ type, text }` — emitted only by reasoning-capable providers; absent otherwise), `done` (`{ type, conversationId, messageId, usage? }` — v1.18.9 adds the optional `usage` envelope `{ totalTokens, promptTokens?, completionTokens?, model? }`, server-authoritative; clients display it, never recompute), or `error` (`{ type, code, message }`). The HTTP status is 200 even for a provider/refusal outcome — clients dispatch on the `error` frame, not the status. Clients ignore unknown frame types (additive evolution). Omitting `conversationId` starts a new conversation. Coach-gated; budget- and rate-limited. Auth via cookie or Bearer.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: coachChatRequestSchema },
        },
      },
      responses: {
        "200": {
          description:
            "Server-Sent Events stream of `token` / `provenance` / `done` / `error` frames.",
          content: {
            "text/event-stream": {
              schema: {
                type: "string",
                description:
                  "SSE frames: `data: <json>\\n\\n`. See the operation description for the per-`type` frame shapes.",
              },
            },
          },
        },
        "403": {
          description:
            "Coach surface disabled (`errorCode: assistant.disabled.coach`) or AI consent required (`errorCode: consent.ai.required`).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "413": {
          description: "Request body exceeds the 64 KB cap.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/chat/{id}": {
    get: {
      tags: ["Insights"],
      summary: "Read one Coach conversation with all messages",
      description:
        "v1.18.0 — returns one conversation with every message decrypted server-side and ordered oldest-first, plus the rolling `summary` when one is on file. The client renders the bodies directly; no decryption key is involved. A foreign / unknown id maps to 404 (never 403) so the existence channel does not leak across accounts. Coach-gated. Auth via cookie or Bearer.",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Conversation id.",
        },
      ],
      responses: {
        "200": {
          description: "The conversation with all decrypted messages.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                coachConversationDetailSchema,
                "CoachConversationDetailResponse",
              ),
            },
          },
        },
        "404": {
          description: "Conversation not found or not owned by the caller.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Insights"],
      summary: "Delete one Coach conversation",
      description:
        "v1.18.0 — hard-deletes a conversation and every message under it. A foreign / unknown id maps to 404 (never 403). Coach-gated. Auth via cookie or Bearer.",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Conversation id.",
        },
      ],
      responses: {
        "200": {
          description: "The conversation was deleted.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                coachConversationDeletedResponse,
                "CoachConversationDeleted",
              ),
            },
          },
        },
        "404": {
          description: "Conversation not found or not owned by the caller.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/layout": {
    get: {
      tags: ["Insights"],
      summary: "Read the calling user's Insights tile layout",
      description:
        "Returns the per-user Insights tile layout (visibility + order). Falls back to the default layout when the user has not customised it. Mirrors the dashboard-widgets contract.",
      responses: {
        "200": {
          description: "The resolved layout (custom or default).",
          content: {
            "application/json": {
              schema: dataEnvelope(insightsLayoutSchema, "InsightsLayout"),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Insights"],
      summary: "Replace the calling user's Insights tile layout",
      description:
        "Persists the full tile layout. The normalised layout is returned. Invalid bodies return the multi-issue 422 envelope, matching the dashboard-widgets route.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: insightsLayoutSchema },
        },
      },
      responses: {
        "200": {
          description: "Layout saved; the normalised layout is echoed back.",
          content: {
            "application/json": {
              schema: dataEnvelope(insightsLayoutSchema, "InsightsLayoutSaved"),
            },
          },
        },
        // 422 (multi-issue validation envelope) comes from stdResponses.
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Insights"],
      summary: "Reset the calling user's Insights tile layout",
      description:
        "Clears the persisted layout and returns the default layout. Idempotent.",
      responses: {
        "200": {
          description: "Layout reset; the default layout is returned.",
          content: {
            "application/json": {
              schema: dataEnvelope(insightsLayoutSchema, "InsightsLayoutReset"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/coach/facts": {
    get: {
      tags: ["Insights"],
      summary: "List the caller's durable Coach facts",
      description:
        "v1.11.1 — returns the active facts the Coach has extracted about the caller (highest-confidence then newest first), each decrypted on the fly. The GDPR 'what do you know about me' surface. Coach-gated (`requireAssistantSurface(\"coach\")`). Auth via cookie or Bearer; the owner is always narrowed from the session, never the body. Undecryptable rows are omitted rather than failing the read.",
      responses: {
        "200": {
          description: "The caller's active facts.",
          content: {
            "application/json": {
              schema: dataEnvelope(coachFactsListResponse, "CoachFactsList"),
            },
          },
        },
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Insights"],
      summary: "Forget all of the caller's Coach facts",
      description:
        "v1.11.1 — bulk 'forget what you know about me': soft-deletes every active fact for the caller and returns the count cleared. Idempotent (a second call clears 0). Coach-gated. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "All active facts cleared; the count is returned.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                coachFactsClearedResponse,
                "CoachFactsCleared",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/coach/facts/{id}": {
    delete: {
      tags: ["Insights"],
      summary: "Forget one Coach fact",
      description:
        "v1.11.1 — soft-deletes a single fact owned by the caller. An unknown / cross-user / already-deleted id is an idempotent no-op returning `{ deleted: false }`, never revealing whether the id exists under another account. Coach-gated. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description:
            "The fact was soft-deleted (`deleted: true`) or the id matched nothing the caller owns (`deleted: false`).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                coachFactDeletedResponse,
                "CoachFactDeleted",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/coach/nudge-status": {
    get: {
      tags: ["Insights"],
      summary: "Whether an unopened Coach message is waiting",
      description:
        'v1.18.6 (CCH-03) — server-authoritative unread signal for the Coach FAB. `unread` is true when the caller\'s newest Coach ASSISTANT message (a proactive nudge or any reply) is newer than `User.coachLastSeenAt`; a user who has never opened the Coach reads an existing nudge as unread exactly once. `nudgedAt` carries that newest assistant-message timestamp (null when none exists) so the client can key a local seen-mirror on a stable value. Coach-gated (`requireAssistantSurface("coach")`); a disabled surface 403s. Auth via cookie or Bearer; the owner is narrowed from the session.',
      responses: {
        "200": {
          description: "The current unread state.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  nudgedAt: z.iso
                    .datetime({ offset: true })
                    .nullable()
                    .describe(
                      "Timestamp of the newest Coach assistant message; null when none exists.",
                    ),
                  unread: z
                    .boolean()
                    .describe(
                      "True when that message is newer than the last time the caller opened the Coach.",
                    ),
                }),
                "CoachNudgeStatus",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/coach/seen": {
    post: {
      tags: ["Insights"],
      summary: "Mark the Coach as opened (clear the unread dot)",
      description:
        "v1.18.6 (CCH-03) — opening the Coach (drawer or full page) stamps `User.coachLastSeenAt = now()`, so `GET /api/insights/coach/nudge-status` then reports no assistant message newer than the stamp and the FAB drops the unread dot. Server-authoritative, so the cleared state follows the caller across web + iOS rather than just the opening device. No request body — the timestamp is server-minted, so a client can never backdate the stamp to suppress a future nudge. Coach-gated; a disabled surface 403s. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "The Coach was marked opened; the stamp is echoed back.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  seenAt: z.iso
                    .datetime({ offset: true })
                    .describe("The server-minted open timestamp."),
                }),
                "CoachSeenResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/coach/about-me": {
    get: {
      tags: ["Insights"],
      summary: "Read the caller's self-context",
      description:
        "v1.16.0 — returns the structured self-context (free text plus chronic conditions, allergies, coach focus) the Coach system prompt and the daily briefing inject as a delimited, user-provided context block, alongside any pending clarifying questions. Every field is stored encrypted at rest; an undecryptable payload reads as null (fail closed). Auth via cookie or Bearer; the owner is always narrowed from the session.",
      responses: {
        "200": {
          description:
            "The stored fields (null when never written / cleared) plus pending clarifying questions.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  aboutMe: z.string().nullable(),
                  conditions: z.string().nullable(),
                  allergies: z.string().nullable(),
                  coachFocus: z.string().nullable(),
                  pendingQuestions: z.array(z.string()),
                  updatedAt: z.iso.datetime({ offset: true }).nullable(),
                  maxChars: z.number().int(),
                  fieldMaxChars: z.number().int(),
                }),
                "GetCoachAboutMeResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Insights"],
      summary: "Write (or clear) the caller's self-context",
      description:
        "v1.16.0 — persists the free text (4 000-char cap) and the three structured fields (500-char cap each) encrypted at rest; caps are enforced before encryption. Structured fields are optional: omitted leaves the stored value untouched, an empty string clears it. After a non-empty save the server derives up to 3 clarifying questions (AI when a provider and the daily Coach token budget allow, deterministic completion hints otherwise) and returns them as `pendingQuestions`. Rate-limited per user.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: aboutMePutSchema } },
      },
      responses: {
        "200": {
          description:
            "The effective (trimmed) state echoed back plus the freshly derived pending questions.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  aboutMe: z.string().nullable(),
                  conditions: z.string().nullable(),
                  allergies: z.string().nullable(),
                  coachFocus: z.string().nullable(),
                  pendingQuestions: z.array(z.string()),
                  updatedAt: z.iso.datetime({ offset: true }),
                  maxChars: z.number().int(),
                  fieldMaxChars: z.number().int(),
                }),
                "PutCoachAboutMeResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/coach/about-me/questions": {
    get: {
      tags: ["Insights"],
      summary: "Read the pending clarifying questions",
      description:
        "v1.16.0 — the up-to-3 clarifying questions derived after the last self-context save. The Coach composer renders them as tappable suggestion chips. Stored encrypted; an undecryptable payload reads as an empty list (fail closed).",
      responses: {
        "200": {
          description: "The pending questions (possibly empty).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ questions: z.array(z.string()) }),
                "GetCoachAboutMeQuestionsResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Insights"],
      summary: "Dismiss pending clarifying questions",
      description:
        "v1.16.0 — dismisses one question (body `{ question }`, exact match) or all of them (empty body). Tapping a chip in the Coach composer inserts the question into the chat input and dismisses it here.",
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: z.object({
              question: z
                .string()
                .optional()
                .describe(
                  "Exact question text to dismiss. Omitted = dismiss all.",
                ),
            }),
          },
        },
      },
      responses: {
        "200": {
          description: "The remaining questions after the dismissal.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ questions: z.array(z.string()) }),
                "DeleteCoachAboutMeQuestionsResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
};

export const coachFeedbackPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/insights/chat/messages/{id}/feedback": {
    post: {
      tags: ["Insights"],
      summary: "Rate a Coach assistant message",
      description:
        "Persists a helpful/unhelpful rating for a single Coach reply. Reuses the v1.4.16 RecommendationFeedback table via the polymorphic `targetType` column. The aggregator buckets ratings by (promptVersion, tone, verbosity).",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: coachMessageFeedbackBody },
        },
      },
      responses: {
        "201": {
          description: "Feedback saved.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  id: z.string(),
                  createdAt: z.iso.datetime({ offset: true }),
                }),
                "CoachMessageFeedbackResponse",
              ),
            },
          },
        },
        "404": {
          description: "Message not found or not owned by the caller.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "409": {
          description: "Caller has already rated this message text.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
};
