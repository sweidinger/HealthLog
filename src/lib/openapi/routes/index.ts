/**
 * OpenAPI route table — thin aggregation index.
 *
 * The route table is split into domain modules under this directory;
 * this index assembles them into the single `openApiPaths` object the
 * registry consumes. The spread order below is load-bearing: the YAML
 * emitter runs with `sortMapEntries: false` (see
 * `scripts/generate-openapi.ts`), so the key order of this object is
 * the path order of the committed `docs/api/openapi.yaml`. Keep the
 * spread sequence stable when adding a module — append inside the
 * domain module, not by reordering here.
 *
 * Schemas come from `src/lib/validations/*` so the wire contract stays
 * single-source-of-truth. The `.meta()` annotations on each schema land
 * the title + description in `components.schemas.*` automatically.
 *
 * Routes are intentionally registered as inline operation objects
 * rather than via a wrapping helper — `zod-openapi`'s `createDocument`
 * type-checks the route table directly, which catches schema-shape
 * regressions at typecheck time.
 */
import type { ZodOpenApiObject } from "zod-openapi";

import { adminDiagnosticPaths, adminInvitePaths } from "./admin";
import { authPaths } from "./auth";
import { coachFeedbackPaths, coachPaths } from "./coach";
import { consentPaths } from "./consent";
import { cyclePaths } from "./cycle";
import { devicePaths } from "./devices";
import { healthRecordPaths } from "./health-record";
import { importPaths } from "./import";
import { insightsPaths } from "./insights";
import { measurementPaths } from "./measurements";
import { measurementReminderPaths } from "./measurement-reminders";
import { medicationPaths, medicationResource } from "./medications";
import { metaPaths } from "./meta";
import { moodPaths } from "./mood";
import { profilePaths } from "./profile";
import { settingsPaths } from "./settings";
import { syncPaths } from "./sync";
import { workoutPaths } from "./workouts";

export const openApiPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  ...cyclePaths,
  ...metaPaths,
  ...healthRecordPaths,
  ...authPaths,
  ...syncPaths,
  ...measurementPaths,
  ...workoutPaths,
  ...devicePaths,
  ...medicationPaths,
  ...profilePaths,
  ...coachPaths,
  ...adminInvitePaths,
  ...coachFeedbackPaths,
  ...adminDiagnosticPaths,
  ...insightsPaths,
  ...moodPaths,
  ...settingsPaths,
  ...consentPaths,
  ...importPaths,
  ...measurementReminderPaths,
};

export const openApiComponents: NonNullable<ZodOpenApiObject["components"]> = {
  // Schemas listed here are forced into `components.schemas` even when no
  // route references them directly. `Medication` lives in this slot
  // because its only consumers are the `MedicationListEntry` /
  // `MedicationDetail` variants which extend it — `.extend()` inlines
  // the base shape into the derived schema, so without an explicit
  // registration the standalone `Medication` component would never
  // emit. The iOS codegen reads from `Medication` directly for the
  // shared Swift struct backing both variants.
  schemas: {
    Medication: medicationResource,
  },
  securitySchemes: {
    bearerAuth: {
      type: "http",
      scheme: "bearer",
      bearerFormat: "hlk_<64hex>",
      description:
        "Native-client API token. Use the `token` field returned by /api/auth/login on a native client.",
    },
    cookieAuth: {
      type: "apiKey",
      in: "cookie",
      name: "healthlog_session",
      description: "Browser session cookie — set by /api/auth/login.",
    },
  },
};
