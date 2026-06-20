/**
 * OpenAPI path table — medications CRUD, intake, cadence, compliance, AI extraction.
 *
 * Schema declarations live in `./schemas`; this module is the path orchestrator.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";
import {
  createMedicationSchema,
  updateMedicationSchema,
  intakeSchema,
  createInventoryItemSchema,
  updateInventoryItemSchema,
} from "@/lib/validations/medication";
import { medicationExtractionSchema } from "@/lib/ai/coach/medication-extract-prompt";
import {
  scheduleRevisionCreateSchema,
  scheduleRevisionUpdateSchema,
} from "@/lib/validations/schedule-revision";
import { dataEnvelope, errorEnvelope, stdResponses } from "../shared";
import {
  medicationListEntry,
  medicationDetailEntry,
  medicationInventoryItemResource,
  medicationIntakeEventResource,
  medicationCadenceResponse,
  medicationComplianceResponse,
  medicationComplianceSummaryEntry,
  scheduleRevisionResource,
  scheduleRevisionListResponse,
  medicationExtractRequest,
  medicationListLayoutSchema,
} from "./schemas";

export const medicationPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/medications": {
    get: {
      tags: ["Medications"],
      summary: "List medications for the calling user",
      description:
        "Returns every medication owned by the caller (active + paused), ordered by `createdAt DESC`. Each row carries its nested `schedules`, the joined clinical `category`, the latest non-skipped `lastTakenAt`, and the count of today's actioned intake events (`todayEventCount`). The response is cached server-side for 60 s per user; writes flush the cache.",
      responses: {
        "200": {
          description: "Medication list.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.array(medicationListEntry),
                "ListMedicationsResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    post: {
      tags: ["Medications"],
      summary: "Create a medication with at least one schedule",
      description:
        "Validates the body against `CreateMedicationRequest`, applies the v1.5 cross-field invariants (one-shot consistency, recurring default `FREQ=DAILY`, `timesOfDay` dual-write), and creates the medication + its schedules in a single Prisma write. Audits as `medication.create`.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: createMedicationSchema } },
      },
      responses: {
        "201": {
          description: "Created medication with its schedules.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationDetailEntry,
                "CreateMedicationResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/layout": {
    get: {
      tags: ["Medications"],
      summary: "Read the calling user's medications list presentation",
      description:
        "Returns the per-user /medications presentation (card/table view + manual order). Falls back to the defaults (cards, empty order) when the user has not customised it. Mirrors the insights-layout contract.",
      responses: {
        "200": {
          description: "The resolved presentation (custom or default).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationListLayoutSchema,
                "MedicationListLayoutResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Medications"],
      summary: "Update the calling user's medications list presentation",
      description:
        "Field-scoped update: `view` and `order` are each optional, and whichever the body omits is preserved from the stored blob — a view toggle can never wipe the manual order and vice versa. The normalised presentation is returned. Invalid bodies return the multi-issue 422 envelope.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: medicationListLayoutSchema },
        },
      },
      responses: {
        "200": {
          description:
            "Presentation saved; the normalised blob is echoed back.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationListLayoutSchema,
                "MedicationListLayoutSaved",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Medications"],
      summary: "Reset the calling user's medications list presentation",
      description:
        "Clears the persisted presentation and returns the defaults (cards, empty order). Idempotent.",
      responses: {
        "200": {
          description: "Presentation reset; the defaults are returned.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationListLayoutSchema,
                "MedicationListLayoutReset",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/{id}": {
    get: {
      tags: ["Medications"],
      summary: "Fetch a single medication",
      description:
        "Returns the medication + its schedules + the joined `category`. Cross-user rows surface as 404 (existence channel sealed).",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      responses: {
        "200": {
          description: "Medication detail.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationDetailEntry,
                "GetMedicationResponse",
              ),
            },
          },
        },
        "404": {
          description: "Medication not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Medications"],
      summary: "Replace a medication (partial fields)",
      description:
        "Every field on the body is optional; omitted fields are left untouched. Supplying `schedules` REPLACES the medication's full schedule list (the route deletes existing rows before re-creating). Flipping `active` to false stamps `pausedAt`; flipping back to true clears it. v1.5 invariants on the `schedules` array match `POST /api/medications`. Audits as `medication.update`.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      requestBody: {
        required: true,
        content: { "application/json": { schema: updateMedicationSchema } },
      },
      responses: {
        "200": {
          description: "Updated medication.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationDetailEntry,
                "UpdateMedicationResponse",
              ),
            },
          },
        },
        "404": {
          description: "Medication not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Medications"],
      summary: "Delete a medication",
      description:
        "Cascades to the medication's schedules, intake events, dose changes, inventory rows, and side-effect logs. Revokes every API token scoped to `medication:<id>:ingest`. Audits as `medication.delete`.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      responses: {
        "200": {
          description: "Deletion succeeded.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ deleted: z.boolean() }),
                "DeleteMedicationResponse",
              ),
            },
          },
        },
        "404": {
          description: "Medication not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/{id}/intake": {
    post: {
      tags: ["Medications"],
      summary: "Log an intake event for a medication",
      description:
        "Records a taken or skipped dose. Idempotent via the `Idempotency-Key` header AND the optional `idempotencyKey` body field (the route walks both paths); a re-post inside the 60 s server-side dedup window returns the original event. Non-skipped intakes auto-decrement pen inventory (best-effort), refresh the per-day compliance rollup, and — for `oneShot:true` medications — flip `active` to false.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      requestBody: {
        required: true,
        content: { "application/json": { schema: intakeSchema } },
      },
      responses: {
        "201": {
          description: "Intake event created.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationIntakeEventResource,
                "CreateMedicationIntakeResponse",
              ),
            },
          },
        },
        "200": {
          description:
            "Idempotent replay — the original event is returned without creating a new row.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationIntakeEventResource,
                "ReplayMedicationIntakeResponse",
              ),
            },
          },
        },
        "404": {
          description: "Medication not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/{id}/inventory": {
    get: {
      tags: ["Medications"],
      summary: "List a medication's supply containers",
      description:
        "Returns every inventory item (all states) for the medication, ordered by state, then `expiresAt`, then `createdAt`. Items count UNITS; divide by the medication's `unitsPerDose` for dose-level figures.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      responses: {
        "200": {
          description: "Inventory item list.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  items: z.array(medicationInventoryItemResource),
                  meta: z.object({ total: z.number().int().nonnegative() }),
                }),
                "ListMedicationInventoryResponse",
              ),
            },
          },
        },
        "404": {
          description: "Medication not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
    post: {
      tags: ["Medications"],
      summary: "Register a new supply container",
      description:
        "Creates an ACTIVE inventory item with `unitsRemaining = unitsTotal`. The request's `unitsTotal` field carries UNITS (1–1000). Rate-limited 30/min/user. Audits as `medication.inventory.create`.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: createInventoryItemSchema },
        },
      },
      responses: {
        "201": {
          description: "Created inventory item.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationInventoryItemResource,
                "CreateMedicationInventoryItemResponse",
              ),
            },
          },
        },
        "404": {
          description: "Medication not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/{id}/inventory/{itemId}": {
    patch: {
      tags: ["Medications"],
      summary: "Mutate a supply container",
      description:
        "Per-item operations: manual first-use (`markAsFirstUseAt`), used-up override (`markAsUsedUp`), printed-expiry correction, absolute remaining-unit correction (`unitsRemaining`, clamped to the item's capacity), notes. The canonical state machine re-derives the state after every mutation. Audits as `medication.inventory.update`.",
      requestParams: {
        path: z.object({ id: z.string(), itemId: z.string() }),
      },
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: updateInventoryItemSchema },
        },
      },
      responses: {
        "200": {
          description: "Updated inventory item.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationInventoryItemResource,
                "UpdateMedicationInventoryItemResponse",
              ),
            },
          },
        },
        "404": {
          description:
            "Inventory item not found (or owned by another user / medication).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Medications"],
      summary: "Delete a supply container",
      description:
        "Hard-deletes the inventory item. The audit log captures the before-state (`medication.inventory.delete`) so a row can be reconstructed if needed. Consumption stamps on intake events that reference the item stay in place; a later restore skips the missing container.",
      requestParams: {
        path: z.object({ id: z.string(), itemId: z.string() }),
      },
      responses: {
        "200": {
          description: "Deletion succeeded.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ id: z.string(), deleted: z.boolean() }),
                "DeleteMedicationInventoryItemResponse",
              ),
            },
          },
        },
        "404": {
          description:
            "Inventory item not found (or owned by another user / medication).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/extract": {
    post: {
      tags: ["Medications"],
      summary:
        "Extract scheduling fields from a free-text medication description",
      description:
        "Runs the user's free-text description through the Coach provider chain and returns a citation-guarded partial payload the wizard merges onto whatever the user already typed. `name` and `dose` are dropped when not substring-matched in the original text so the wizard cannot land a hallucinated brand or dose. `cadenceKind` / `doseUnit` / `weekdays` are closed enums; numeric fields are clamped. Rate-limited 10 requests / 5 minutes / user, gated against the daily Coach token budget.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: medicationExtractRequest },
        },
      },
      responses: {
        "200": {
          description: "Citation-guarded partial extraction.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationExtractionSchema,
                "MedicationExtractResponse",
              ),
            },
          },
        },
        "502": {
          description:
            "Upstream provider returned an empty, unparseable, or off-schema reply.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "503": {
          description:
            "No AI provider configured for the calling user (or operator).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/{id}/cadence": {
    get: {
      tags: ["Medications"],
      summary: "Cadence + compliance read for a medication",
      description:
        "Returns the expected-vs-actual dose timeline for the requested window plus the four compliance chip values that drive the detail-page section. Pure computation — no writes. Day boundaries are resolved in the user's IANA timezone so a Tokyo user and a Berlin user see the same chips for the same medication. The `days` query parameter caps at 180.",
      requestParams: {
        path: z.object({ id: z.string() }),
        query: z.object({
          days: z.coerce
            .number()
            .int()
            .min(1)
            .max(180)
            .optional()
            .describe("Window size in days (default 30, max 180)."),
        }),
      },
      responses: {
        "200": {
          description: "Cadence response.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationCadenceResponse,
                "GetMedicationCadenceResponse",
              ),
            },
          },
        },
        "404": {
          description: "Medication not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/compliance": {
    get: {
      tags: ["Medications"],
      summary: "Batched adherence read for every medication of the caller",
      description:
        "Returns one compact adherence row per medication the caller owns (active + paused), ordered by `createdAt DESC` — the single round trip the medication cards consume instead of fanning out one `/api/medications/{id}/compliance` request per card. Each row carries the 7-/30-day summaries and the cadence-scaled display block; the per-day grid stays on the per-medication endpoint. Pure computation — no writes. Served through the same per-medication server cache as the per-id read, so the two endpoints warm each other.",
      responses: {
        "200": {
          description: "One adherence row per medication.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.array(medicationComplianceSummaryEntry),
                "ListMedicationComplianceResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/{id}/compliance": {
    get: {
      tags: ["Medications"],
      summary: "Adherence read for a medication",
      description:
        "Returns the 7- and 30-day adherence summaries, the per-day compliance grid for the history glyph track, and the two-row display block. Pure computation — no writes. Day boundaries are resolved in the user's IANA timezone, and the expected-dose denominator is cadence-aware (RRULE / rolling / one-shot / PRN / cyclic) and clamped to the medication's `createdAt`. Read `compliance30` for the headline 30-day taken-vs-expected percentage; build the per-day glyph track from `dailyCompliance` (draw a cell only where `due === true`).",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      responses: {
        "200": {
          description: "Compliance response.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationComplianceResponse,
                "GetMedicationComplianceResponse",
              ),
            },
          },
        },
        "404": {
          description: "Medication not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/{id}/schedule-revisions": {
    get: {
      tags: ["Medications"],
      summary: "List a medication's archived schedule eras",
      description:
        "Returns every archived schedule era (newest first) plus `currentSince`, the instant the live plan took over. The dose-history ledger and compliance tallies already mint past days against these eras; this read powers the Zeitplan-tab history timeline.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      responses: {
        "200": {
          description: "Era list.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                scheduleRevisionListResponse,
                "ListScheduleRevisionsResponse",
              ),
            },
          },
        },
        "404": {
          description: "Medication not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
    post: {
      tags: ["Medications"],
      summary: "Append a manual schedule era (pre-tracking history)",
      description:
        "Records that the medication dosed at the given daily times during `[validFrom, validUntil)` — history from before the schedule was edited in the app. The era must end at or before the start of the live plan and must not overlap an existing era; violations return 422. The snapshot is shaped exactly like a write-path archive (`FREQ=DAILY`, window pulled to the min/max of the times), so every historical surface reads it transparently. Audits as `medication.schedule_revision.created`.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: scheduleRevisionCreateSchema },
        },
      },
      responses: {
        "201": {
          description: "Manual era created.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                scheduleRevisionResource,
                "CreateScheduleRevisionResponse",
              ),
            },
          },
        },
        "404": {
          description: "Medication not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/{id}/schedule-revisions/{revisionId}": {
    patch: {
      tags: ["Medications"],
      summary: "Correct a recorded schedule era",
      description:
        "Replaces an era's bounds and daily times. A `MANUAL` era updates in place; an `ARCHIVED` era stays as the immutable audit record and the correction is minted as a superseding `MANUAL` revision that takes its place in every historical surface (the response carries the correction's id). Validation mirrors the sibling POST: the era must end at or before the start of the live plan and must not overlap another active era; violations return 422. An era that has already been corrected refuses with 409. Audits as `medication.schedule_revision.updated`.",
      requestParams: {
        path: z.object({ id: z.string(), revisionId: z.string() }),
      },
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: scheduleRevisionUpdateSchema },
        },
      },
      responses: {
        "200": {
          description: "Era corrected.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                scheduleRevisionResource,
                "UpdateScheduleRevisionResponse",
              ),
            },
          },
        },
        "404": {
          description:
            "Medication or revision not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "409": {
          description:
            "The revision has already been superseded by a correction.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Medications"],
      summary: "Delete a manually added schedule era",
      description:
        "Removes a `MANUAL` era — one appended through the sibling POST, or a correction minted by PATCH (deleting a correction restores the archived original it superseded). Write-path archives (`source: ARCHIVED`) are immutable history and refuse with 409. Audits as `medication.schedule_revision.deleted`.",
      requestParams: {
        path: z.object({ id: z.string(), revisionId: z.string() }),
      },
      responses: {
        "200": {
          description: "Deletion succeeded.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ deleted: z.boolean() }),
                "DeleteScheduleRevisionResponse",
              ),
            },
          },
        },
        "404": {
          description:
            "Medication or revision not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "409": {
          description:
            "The revision is a write-path archive (`ARCHIVED`) and cannot be deleted.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
};
