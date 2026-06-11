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
import { exportSelectionSchema } from "@/lib/validations/health-record-export";
import { createShareLinkSchema } from "@/lib/validations/clinician-share-link";
import { dataEnvelope, errorEnvelope, stdResponses } from "./shared";

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

export const coachPaths: NonNullable<ZodOpenApiObject["paths"]> = {
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
