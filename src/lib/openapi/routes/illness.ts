/**
 * OpenAPI route table for the illness / condition journal (`/api/illness`).
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`. The request
 * bodies + queries reuse the runtime Zod schemas from `@/lib/validations/illness`
 * so the wire contract stays single-source. Response shapes are declared here
 * to mirror the server-authoritative DTOs in `@/lib/illness/dto.ts` (the routes
 * serialise a decrypted `note` + flattened `symptoms` the input schemas don't
 * carry; iOS renders the DTO, it never recomputes it).
 *
 * The journal is a CONDITION journal, retrospective-only — never a
 * predictor/diagnoser. Every route is born-gated: a non-opted-in account (or
 * an operator-disabled instance) 403s with `errorCode:"illness.disabled"`
 * even with a valid Bearer token.
 */
import type { ZodOpenApiObject } from "zod-openapi";
import { z } from "zod/v4";

import {
  illnessEpisodeCreateSchema,
  illnessEpisodeUpdateSchema,
  illnessEpisodeResolveSchema,
  illnessEpisodeListQuerySchema,
  illnessDayLogInputSchema,
  illnessDayLogQuerySchema,
  illnessTypeEnum,
  illnessLifecycleEnum,
} from "@/lib/validations/illness";

import { dataEnvelope, errorEnvelope, stdResponses } from "./shared";

illnessEpisodeCreateSchema.meta({
  id: "CreateIllnessEpisodeRequest",
  description:
    "Open an illness/condition episode. `label` is the user-facing name; `type` + `lifecycle` classify it. `onsetAt` defaults to 'now' server-side when omitted. `parentConditionId` threads a FLARE/RECURRING bout under a parent condition (must be an owned, live episode). The optional `note` is encrypted at rest.",
});

illnessEpisodeUpdateSchema.meta({
  id: "UpdateIllnessEpisodeRequest",
  description:
    "Partial edit of an episode; an omitted key leaves the column untouched. A `null` `resolvedAt` re-opens a resolved episode; a `null` `parentConditionId` detaches it from its parent. Rejects unknown keys.",
});

illnessEpisodeResolveSchema.meta({
  id: "ResolveIllnessEpisodeRequest",
  description:
    "Mark an episode recovered. `resolvedAt` defaults to 'now' when omitted, so the one-tap 'mark recovered' affordance can send an empty body. A CHRONIC_ONGOING episode has no recovery date by design and 422s.",
});

illnessEpisodeListQuerySchema.meta({
  id: "ListIllnessEpisodesQuery",
  description:
    "Query params for the episode history: optional `limit` (1–100, default 50) and `includeResolved` ('true' | 'false'); 'false' hides episodes that already carry a `resolvedAt`. Newest-first by `onsetAt`.",
});

illnessDayLogInputSchema.meta({
  id: "UpsertIllnessDayLogRequest",
  description:
    "Upsert one day's symptom / functional-impact / fever row for an episode (keyed on `(episodeId, date)`). `date` is a `YYYY-MM-DD` tz-anchored day. `functionalImpact` (0–3) + `feverC` are queryable plaintext; `symptoms` carry an optional 0–3 Jackson/WURSS severity per link; the optional `note` is encrypted at rest.",
});

illnessDayLogQuerySchema.meta({
  id: "GetIllnessDayLogQuery",
  description:
    "Single-day read query: `date` is a `YYYY-MM-DD` day. Returns the matching day-log or `null` when nothing is logged for that day.",
});

const illnessSymptom = z
  .object({
    key: z.string(),
    severity: z.number().int().nullable(),
  })
  .meta({
    id: "IllnessSymptom",
    description:
      "A symptom link on a day-log: the catalog `key` plus an optional 0–3 severity (`null` = a plain presence link).",
  });

const illnessEpisode = z
  .object({
    id: z.string(),
    label: z.string(),
    type: illnessTypeEnum,
    lifecycle: illnessLifecycleEnum,
    onsetAt: z.string(),
    resolvedAt: z.string().nullable(),
    parentConditionId: z.string().nullable(),
    note: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({
    id: "IllnessEpisode",
    description:
      "A stored illness/condition episode. `note` is the decrypted free-text (or null on a key-rotation gap — fail-soft, never 500). `resolvedAt` is null while the episode is open. `parentConditionId` links a FLARE/RECURRING bout to its parent condition.",
  });

const illnessDayLog = z
  .object({
    id: z.string(),
    episodeId: z.string(),
    date: z.string(),
    functionalImpact: z.number().int().nullable(),
    feverC: z.number().nullable(),
    symptoms: z.array(illnessSymptom),
    note: z.string().nullable(),
    updatedAt: z.string(),
  })
  .meta({
    id: "IllnessDayLog",
    description:
      "A stored day-log for an episode. `date` is the `YYYY-MM-DD` it covers. `functionalImpact` (0–3) and `feverC` are plaintext; `symptoms` flattens the link rows; `note` is the decrypted free-text (or null).",
  });

const episodeNotFound = {
  "404": {
    description: "Illness episode not found (or owned by another user).",
    content: { "application/json": { schema: errorEnvelope } },
  },
} as const;

export const illnessPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/illness/episodes": {
    get: {
      tags: ["Illness"],
      summary: "List illness episodes (v1.18.1)",
      description:
        "Returns the caller's live (non-deleted) illness/condition episodes, newest-first by onset. `includeResolved=false` hides episodes that already carry a `resolvedAt`. Born-gated.",
      requestParams: { query: illnessEpisodeListQuerySchema },
      responses: {
        "200": {
          description: "The caller's illness episodes.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.array(illnessEpisode),
                "ListIllnessEpisodesEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    post: {
      tags: ["Illness"],
      summary: "Open an illness episode (v1.18.1)",
      description:
        "Creates one episode for the caller. `onsetAt` defaults to 'now' when omitted; the optional note is AES-256-GCM encrypted before write. A `parentConditionId` must reference an owned, live episode. Audits as `illness.episode.create`. Born-gated.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: illnessEpisodeCreateSchema },
        },
      },
      responses: {
        "201": {
          description: "Episode created.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                illnessEpisode,
                "CreateIllnessEpisodeEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/illness/episodes/{id}": {
    get: {
      tags: ["Illness"],
      summary: "Read a single illness episode (v1.18.1)",
      description:
        "Returns the episode including its decrypted `note`. Owner-scoped; a cross-user or tombstoned id 404s. Born-gated.",
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        "200": {
          description: "The episode.",
          content: {
            "application/json": {
              schema: dataEnvelope(illnessEpisode, "GetIllnessEpisodeEnvelope"),
            },
          },
        },
        ...episodeNotFound,
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Illness"],
      summary: "Edit an illness episode (v1.18.1)",
      description:
        "Partial edit; omitted fields are left untouched. A re-parent must point at an owned, live episode (and never the episode itself). Audits as `illness.episode.update`. Owner-scoped + born-gated.",
      requestParams: { path: z.object({ id: z.string() }) },
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: illnessEpisodeUpdateSchema },
        },
      },
      responses: {
        "200": {
          description: "Episode updated.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                illnessEpisode,
                "UpdateIllnessEpisodeEnvelope",
              ),
            },
          },
        },
        ...episodeNotFound,
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Illness"],
      summary: "Soft-delete an illness episode (v1.18.1)",
      description:
        "Stamps `deletedAt` (tombstone). Idempotent — a re-delete is a no-op. Returns 204 No Content. Audits as `illness.episode.delete`. Owner-scoped + born-gated.",
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        "204": { description: "Soft-deleted (no body)." },
        ...episodeNotFound,
        ...stdResponses,
      },
    },
  },
  "/api/illness/episodes/{id}/resolve": {
    patch: {
      tags: ["Illness"],
      summary: "Mark an illness episode recovered (v1.18.1)",
      description:
        "Stamps `resolvedAt` (defaults to 'now' when the body omits it). A CHRONIC_ONGOING episode has no recovery date and 422s with `errorCode:\"illness.episode.chronic-no-resolve\"`. Audits as `illness.episode.resolve`. Owner-scoped + born-gated.",
      requestParams: { path: z.object({ id: z.string() }) },
      requestBody: {
        required: false,
        content: {
          "application/json": { schema: illnessEpisodeResolveSchema },
        },
      },
      responses: {
        "200": {
          description: "Episode resolved.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                illnessEpisode,
                "ResolveIllnessEpisodeEnvelope",
              ),
            },
          },
        },
        ...episodeNotFound,
        ...stdResponses,
      },
    },
  },
  "/api/illness/episodes/{id}/day-logs": {
    get: {
      tags: ["Illness"],
      summary: "Read one day-log for an episode (v1.18.1)",
      description:
        "Returns the day-log for the episode + `date`, or `null` when nothing is logged that day (lets the log-day sheet pre-fill). The parent episode must be owned + live. Born-gated.",
      requestParams: {
        path: z.object({ id: z.string() }),
        query: illnessDayLogQuerySchema,
      },
      responses: {
        "200": {
          description: "The day-log, or null.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                illnessDayLog.nullable(),
                "GetIllnessDayLogEnvelope",
              ),
            },
          },
        },
        ...episodeNotFound,
        ...stdResponses,
      },
    },
    post: {
      tags: ["Illness"],
      summary: "Upsert an episode day-log (v1.18.1)",
      description:
        "Upserts the day's symptom / functional-impact / fever timeline row on `(episodeId, date)`: 201 on insert, 200 on update. The parent episode must be owned + live; the optional note is encrypted at rest. Audits as `illness.day-log.upsert`. Born-gated.",
      requestParams: { path: z.object({ id: z.string() }) },
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: illnessDayLogInputSchema },
        },
      },
      responses: {
        "200": {
          description: "Existing day-log updated.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                illnessDayLog,
                "UpsertIllnessDayLogUpdatedEnvelope",
              ),
            },
          },
        },
        "201": {
          description: "New day-log created.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                illnessDayLog,
                "UpsertIllnessDayLogCreatedEnvelope",
              ),
            },
          },
        },
        ...episodeNotFound,
        ...stdResponses,
      },
    },
  },
};
