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
  illnessInsightsQuerySchema,
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

illnessInsightsQuerySchema.meta({
  id: "IllnessInsightsQuery",
  description:
    "Cross-episode retrospective window query: optional `windowDays` (30–1095, default 365). Retrospective only — the engine summarises past episodes, never forecasts.",
});

const illnessSymptom = z
  .object({
    key: z.string(),
    severity: z.number().int().nullable(),
  })
  .meta({
    id: "IllnessSymptom",
    description:
      "A symptom link on a day-log: the catalog `key` plus an optional 1–3 graded severity (`null` = a plain presence link; the link's presence already means 'present', so 0 is not a distinct state).",
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

/* ── P3 retrospective correlation + cross-episode insights DTOs ───────── */

const illnessVitalDeviation = z
  .object({
    type: z.string(),
    day: z.string(),
    value: z.number(),
    baselineCenter: z.number(),
    deviationSd: z.number(),
    direction: z.enum(["above", "below"]),
    adverse: z.boolean(),
  })
  .meta({
    id: "IllnessVitalDeviation",
    description:
      "One vital's deviation finding on a day: signed deviation in robust-SD units from the user's OWN baseline (median ± MAD), the direction, and whether the move is illness-adverse for that metric.",
  });

const illnessVitalReturn = z
  .object({
    type: z.string(),
    returnedDay: z.string().nullable(),
    gapDays: z.number().nullable(),
  })
  .meta({
    id: "IllnessVitalReturn",
    description:
      "A vital's physiological return: the first day it re-entered its band AND held, and the signed gap (days) from the felt-better marker (positive = the body lagged the feeling).",
  });

const illnessRedFlag = z
  .object({
    type: z.string(),
    reason: z.enum(["sustained_low_spo2", "sustained_fever"]),
    worstValue: z.number(),
    days: z.number().int(),
  })
  .meta({
    id: "IllnessRedFlag",
    description:
      "A retrospective red-flag escalation (sustained low SpO2 or sustained fever) against absolute clinical floors. Copy must escalate ('seek care if this recurs'), never reassure.",
  });

const illnessCorrelationValue = z
  .object({
    episodeId: z.string(),
    preOnset: z.array(illnessVitalDeviation),
    nadir: z.array(illnessVitalDeviation),
    returns: z.array(illnessVitalReturn),
    recoveryGapDays: z.number().nullable(),
    feltBetterDay: z.string().nullable(),
    redFlags: z.array(illnessRedFlag),
  })
  .meta({
    id: "IllnessCorrelationValue",
    description:
      "The retrospective correlation findings for one episode: pre-onset anomaly scan, nadir, per-vital physiological returns, the headline recovery-gap (median of per-vital gaps), and any red flags.",
  });

const illnessCorrelationResponse = z
  .object({
    episodeId: z.string(),
    status: z.enum(["ok", "insufficient"]),
    value: illnessCorrelationValue.nullable(),
    coverage: z.object({
      requiredInputs: z.number().int(),
      presentInputs: z.number().int(),
      historyDays: z.number().int(),
      missing: z.array(z.string()),
    }),
    confidence: z
      .object({ score: z.number(), band: z.string() })
      .nullable(),
    provenance: z.object({
      inputs: z.array(z.string()),
      source: z.string(),
      windowDays: z.number().int(),
      computedAt: z.string(),
    }),
    reason: z.string().nullable(),
  })
  .meta({
    id: "IllnessCorrelationResponse",
    description:
      "Coverage-gated `Derived<T>` wire shape for the per-episode correlation. `status:\"insufficient\"` carries coverage + a reason and a null `value` — the surface renders 'still learning', never a fabricated number. Server-authoritative; iOS pattern-matches `status`, never recomputes.",
  });

const illnessInsightsResponse = z
  .object({
    windowDays: z.number().int(),
    episodeCount: z.number().int(),
    resolvedCount: z.number().int(),
    typicalRecoveryGapDays: z.number().nullable(),
    gapSampleSize: z.number().int(),
    byMonth: z.record(z.string(), z.number().int()),
    byType: z.record(z.string(), z.number().int()),
  })
  .meta({
    id: "IllnessInsightsResponse",
    description:
      "Cross-episode retrospective summary over the trailing window: episode + resolved counts, the typical (median) recovery gap (null below the min-sample floor — withholds a thin claim), a recurrence-by-month tally, and a per-type breakdown. Retrospective only.",
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
        "Stamps `deletedAt` (tombstone). Idempotent — a re-delete is a no-op. Returns the `{ deleted: true }` envelope (the cross-module DELETE shape). Audits as `illness.episode.delete`. Owner-scoped + born-gated.",
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        "200": {
          description: "Soft-deleted.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ deleted: z.boolean() }),
                "DeleteIllnessEpisodeEnvelope",
              ),
            },
          },
        },
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
  "/api/illness/episodes/{id}/correlation": {
    get: {
      tags: ["Illness"],
      summary: "Per-episode retrospective correlation (v1.18.1)",
      description:
        "Returns the coverage-gated `Derived<T>` correlation for one episode: the pre-onset anomaly scan, the nadir, per-vital physiological returns, the headline recovery-gap, and any red flags. The findings derive from the user's OWN baseline (median ± MAD) over a contamination-guarded window — never a population constant. `status:\"insufficient\"` carries coverage + a reason. Retrospective ONLY — never a predictor or diagnoser. Owner-scoped + born-gated.",
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        "200": {
          description: "The correlation Derived DTO (ok or insufficient).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                illnessCorrelationResponse,
                "IllnessCorrelationEnvelope",
              ),
            },
          },
        },
        ...episodeNotFound,
        ...stdResponses,
      },
    },
  },
  "/api/illness/insights": {
    get: {
      tags: ["Illness"],
      summary: "Cross-episode retrospective insights (v1.18.1)",
      description:
        "Returns the cross-episode retrospective summary over a trailing window: 'sick N times · typical recovery gap X days', a recurrence-by-month tally, and a per-type breakdown. The typical gap is withheld (null) below the min-sample floor (asserts nothing thin). Retrospective ONLY — the recurrence figure is a count of the past, never a forecast. Born-gated + owner-scoped.",
      requestParams: { query: illnessInsightsQuerySchema },
      responses: {
        "200": {
          description: "The cross-episode retrospective summary.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                illnessInsightsResponse,
                "IllnessInsightsEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
};
