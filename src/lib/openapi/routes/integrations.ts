/**
 * OpenAPI route table — third-party integration config (HealthKit).
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 * Response DTOs are declared here mirroring the route handler under
 * `src/app/api/integrations/healthkit/route.ts`; the request schema
 * mirrors the handler's `patchSchema`.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";
import { dataEnvelope, stdResponses } from "./shared";

// Mirror the route's `directionEnum` — per-metric sync direction.
const healthKitDirectionEnum = z
  .enum(["bidirectional", "readOnly", "writeOnly", "disabled"])
  .describe("Per-metric sync direction.");

// Resolved entry (defaults merged): `kind` + `enabled` are always present.
const healthKitEntry = z
  .object({
    id: z.string().describe("Stable metric key (e.g. `bodyMass`)."),
    kind: z.string().describe("HealthKit sample kind (e.g. `bloodPressure`)."),
    direction: healthKitDirectionEnum,
    enabled: z.boolean(),
  })
  .meta({
    id: "HealthKitEntry",
    description:
      "One resolved HealthKit metric mapping (defaults merged with the user's stored overrides).",
  });

const healthKitConfigResponse = z
  .object({
    entries: z.array(healthKitEntry),
    lastSyncedAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe(
        "When HealthKit last synced for this user; null when never (and always null on the PATCH echo).",
      ),
  })
  .meta({
    id: "HealthKitConfigResponse",
    description:
      "The resolved HealthKit integration config: the default metric set merged with the user's stored per-metric overrides.",
  });

// Mirror the route's `patchSchema` — merge-by-id; unknown ids are ignored.
const healthKitPatchEntry = z.object({
  id: z.string().min(1).max(64),
  kind: z.string().min(1).max(64).optional(),
  direction: healthKitDirectionEnum,
  enabled: z.boolean().optional(),
});

const healthKitPatchRequest = z
  .object({
    entries: z.array(healthKitPatchEntry).max(50),
  })
  .meta({
    id: "HealthKitConfigPatchRequest",
    description:
      "Merge-by-`id` update of the HealthKit metric config. Unknown ids are silently ignored; omitted fields fall back to the stored (or default) value for that entry. Up to 50 entries per call.",
  });

export const integrationPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/integrations/healthkit": {
    get: {
      tags: ["Integrations"],
      summary: "Read the HealthKit integration config",
      description:
        "Returns the resolved per-metric HealthKit config — the default metric set merged with the user's stored overrides — plus the last HealthKit sync instant. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "Resolved HealthKit config.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                healthKitConfigResponse,
                "HealthKitConfigEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Integrations"],
      summary: "Update the HealthKit integration config",
      description:
        "Merges the supplied entries into the stored config by `id` (unknown ids are ignored) and returns the resolved config (defaults merged) so the client always sees a complete metric list. `lastSyncedAt` is null on the echo. Auth via cookie or Bearer.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: healthKitPatchRequest },
        },
      },
      responses: {
        "200": {
          description: "Updated + resolved HealthKit config.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                healthKitConfigResponse,
                "HealthKitConfigPatchEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
};
