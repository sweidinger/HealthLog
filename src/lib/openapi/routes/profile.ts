/**
 * OpenAPI route table — account profile, avatar, coach prefs, disable-coach, source priority.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 * Schemas come from `src/lib/validations/*` where shared with the
 * runtime request parsing, so the wire contract stays single-source.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";
import { coachPrefsSchema } from "@/lib/validations/coach-prefs";
import { sourcePrioritySchema } from "@/lib/validations/source-priority";
import { dataEnvelope, errorEnvelope, stdResponses } from "./shared";

// v1.4.49 — single schema for the per-user Coach opt-out flag. Previously
// split into `disableCoachBody` (PATCH request) and `disableCoachData`
// (response payload), both `z.object({ disableCoach: z.boolean() })`. The
// payload was passed through `dataEnvelope(..., "GetDisableCoachResponse")`
// / `dataEnvelope(..., "PatchDisableCoachResponse")` which IDs the
// envelope wrapper — the inner flag carries its own `.meta()` and now
// renders as a single `$ref: "#/components/schemas/DisableCoachFlag"` in
// both the request body and both response envelopes.
const disableCoachFlag = z
  .object({
    disableCoach: z.boolean(),
  })
  .meta({
    id: "DisableCoachFlag",
    description:
      "Per-account Coach opt-out toggle (v1.4.47 W3). `true` hides the Coach FAB and short-circuits its API gates.",
  });

// v1.8.6 — profile read/write surface for the native client. The
// runtime validation lives in `src/lib/validations/auth.ts`
// (`profileSchema`, whose transforms normalise empty → null and run the
// KVNR/IKNR refines); the OpenAPI shapes below mirror the wire contract
// without those transforms so the spec stays a clean nullable-field
// document. `insurerIkNumber` is the new v1.8.6 field: optional, 9-digit
// German IKNR, surfaced on the FHIR `Coverage` payor.
const profileUpdateRequest = z
  .object({
    email: z.email().nullable().optional(),
    heightCm: z.number().min(50).max(300).nullable().optional(),
    dateOfBirth: z.string().nullable().optional(),
    gender: z.enum(["MALE", "FEMALE"]).nullable().optional(),
    displayName: z.string().min(1).max(80).nullable().optional(),
    locale: z.enum(["de", "en"]).nullable().optional(),
    timezone: z.string().min(1).max(64).optional(),
    timeFormat: z
      .enum(["AUTO", "H12", "H24"])
      .optional()
      .describe(
        "Hour-cycle display preference. AUTO follows the locale convention, H12 forces AM/PM, H24 forces 24-hour.",
      ),
    moodReminderEnabled: z.boolean().optional(),
    fullName: z.string().max(120).nullable().optional(),
    insurerName: z.string().max(120).nullable().optional(),
    insuranceNumber: z
      .string()
      .nullable()
      .optional()
      .describe("German KVNR. Empty/null clears it; mod-10 check enforced."),
    insurerIkNumber: z
      .string()
      .nullable()
      .optional()
      .describe(
        "German insurer institution number (IKNR). Optional; empty/null clears it. A non-empty value must be exactly 9 digits (no checksum enforced).",
      ),
  })
  .meta({
    id: "ProfileUpdateRequest",
    description:
      "Partial profile update. Every field is optional; an omitted field is left untouched, an explicit null (or empty string) clears it. `userId` is never accepted — it is narrowed from the session/token.",
  });

const profileResponse = z
  .object({
    username: z.string(),
    displayName: z.string().nullable().optional(),
    email: z.string().nullable(),
    dateOfBirth: z.iso.datetime({ offset: true }).nullable(),
    gender: z.enum(["MALE", "FEMALE"]).nullable(),
    heightCm: z.number().nullable(),
    locale: z.string().nullable(),
    timezone: z.string(),
    timeFormat: z
      .enum(["AUTO", "H12", "H24"])
      .describe(
        "Hour-cycle display preference. AUTO follows the locale convention, H12 forces AM/PM, H24 forces 24-hour.",
      ),
    moodReminderEnabled: z.boolean(),
    fullName: z.string().nullable(),
    insurerName: z.string().nullable(),
    insurerIkNumber: z
      .string()
      .nullable()
      .describe("German insurer institution number (IKNR), 9 digits."),
    insuranceNumber: z
      .string()
      .nullable()
      .describe("German KVNR, decrypted for the form prefill."),
  })
  .meta({
    id: "ProfileResponse",
    description:
      "Flattened profile fields for the native client (GET). The KVNR is decrypted server-side; the IKNR (v1.8.6) is plaintext at rest.",
  });

// The PATCH echo mirrors GET but reports KVNR presence as a boolean
// (`hasInsuranceNumber`) rather than re-emitting the decrypted value.
const profileUpdateResponse = z
  .object({
    username: z.string(),
    displayName: z.string().nullable().optional(),
    email: z.string().nullable(),
    dateOfBirth: z.iso.datetime({ offset: true }).nullable(),
    gender: z.enum(["MALE", "FEMALE"]).nullable(),
    heightCm: z.number().nullable(),
    locale: z.string().nullable(),
    timezone: z.string(),
    timeFormat: z
      .enum(["AUTO", "H12", "H24"])
      .describe(
        "Hour-cycle display preference. AUTO follows the locale convention, H12 forces AM/PM, H24 forces 24-hour.",
      ),
    moodReminderEnabled: z.boolean(),
    fullName: z.string().nullable(),
    insurerName: z.string().nullable(),
    insurerIkNumber: z
      .string()
      .nullable()
      .describe("German insurer institution number (IKNR), 9 digits."),
    hasInsuranceNumber: z
      .boolean()
      .describe("Whether a KVNR is on file (the value itself is not echoed)."),
  })
  .meta({
    id: "ProfileUpdateResponse",
    description:
      "Profile echo returned by the PATCH/PUT update path. Reports KVNR presence as a boolean rather than re-emitting the decrypted value.",
  });

export const profilePaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/auth/me/coach-prefs": {
    get: {
      tags: ["Auth"],
      summary: "Read per-user Coach prompt-tuning preferences",
      description:
        "Returns the persisted preferences with defaults filled in. Null persisted state resolves to the legacy v1.4.22 defaults.",
      responses: {
        "200": {
          description: "Resolved preferences.",
          content: {
            "application/json": {
              schema: dataEnvelope(coachPrefsSchema, "GetCoachPrefsResponse"),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Auth"],
      summary: "Replace per-user Coach prompt-tuning preferences",
      description:
        "Persists the supplied prefs. Body is validated against `CoachPrefs`; missing keys fall back to the documented defaults.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: coachPrefsSchema } },
      },
      responses: {
        "200": {
          description: "Saved preferences echoed back.",
          content: {
            "application/json": {
              schema: dataEnvelope(coachPrefsSchema, "PutCoachPrefsResponse"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/disable-coach": {
    get: {
      tags: ["Auth"],
      summary: "Read per-user Coach opt-out flag",
      description:
        'Returns the user\'s per-account Coach opt-out flag. Default `false` (Coach visible). Powers the Settings → Insights "Hide Coach" Switch and the layout FAB short-circuit.',
      responses: {
        "200": {
          description: "Resolved flag.",
          content: {
            "application/json": {
              schema: dataEnvelope(disableCoachFlag, "GetDisableCoachResponse"),
            },
          },
        },
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Auth"],
      summary: "Toggle per-user Coach opt-out flag",
      description:
        "Flips the per-account Coach opt-out flag. Idempotent — the DB write fires even when the value matches so the audit-log row mirrors the API call. Rate-limit 60/min per user.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: disableCoachFlag } },
      },
      responses: {
        "200": {
          description:
            "Resolved next-state echoed back for optimistic-update consumers.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                disableCoachFlag,
                "PatchDisableCoachResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/source-priority": {
    get: {
      tags: ["Auth"],
      summary: "Read per-user source priority",
      description:
        "Returns the per-metric-class source priority used by the analytics aggregator. Missing keys fall back to `DEFAULT_SOURCE_PRIORITY`. Null persisted state resolves to the documented defaults.",
      responses: {
        "200": {
          description: "Resolved priority.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                sourcePrioritySchema,
                "GetSourcePriorityResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Auth"],
      summary: "Replace per-user source priority",
      description:
        "Persists the supplied priority. Body is validated against `SourcePriority`; missing keys read as `DEFAULT_SOURCE_PRIORITY` at the call site.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: sourcePrioritySchema } },
      },
      responses: {
        "200": {
          description: "Saved priority (defaulted) echoed back.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                sourcePrioritySchema,
                "PutSourcePriorityResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/user/avatar": {
    post: {
      tags: ["Auth"],
      summary: "Upload the calling user's avatar",
      description:
        "Multipart upload (field `file`). Accepts image/jpeg, image/png, image/webp; rejects anything else at the magic-byte sniff (the multipart Content-Type header is informational only). Hard caps: 2 MiB body, 2048×2048 dimensions. Replaces the v1.4.22 Gravatar leak by storing the bytes on the User row + serving them from same-origin.",
      requestBody: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: z.object({
              file: z
                .string()
                .describe(
                  "Binary image payload (JPEG / PNG / WebP). Hard-capped at 2 MiB and 2048×2048.",
                ),
            }),
          },
        },
      },
      responses: {
        "201": {
          description:
            "Avatar saved. `avatarUrl` is the same value the /me payload returns; the `?v=` suffix busts client caches on re-upload.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  avatarUrl: z.string(),
                  contentType: z.enum([
                    "image/jpeg",
                    "image/png",
                    "image/webp",
                  ]),
                  updatedAt: z.iso.datetime({ offset: true }),
                }),
                "UploadAvatarResponse",
              ),
            },
          },
        },
        "413": {
          description:
            "Upload exceeds the 2 MiB byte limit or the 2048×2048 dimension limit.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "415": {
          description:
            "Image format is not one of JPEG / PNG / WebP (magic-byte sniff).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Auth"],
      summary: "Clear the calling user's avatar",
      description:
        "Resets the avatar columns to null. Idempotent — a delete on an already-empty row returns 204 with no audit-log row.",
      responses: {
        "204": {
          description: "Avatar cleared (or already empty).",
        },
        ...stdResponses,
      },
    },
  },
  "/api/user/avatar/{id}": {
    get: {
      tags: ["Auth"],
      summary: "Serve a user's avatar bytes",
      description:
        "Owner-scoped. The `{id}` path segment must match the calling user's id — cross-user reads return 403. Response body is the raw image bytes with the persisted `Content-Type`; the /me payload appends `?v={updatedAtMs}` so clients can cache aggressively.",
      requestParams: {
        path: z.object({
          id: z.string().describe("User id (must match the calling user)."),
        }),
      },
      responses: {
        "200": {
          description: "Avatar bytes.",
          content: {
            "image/jpeg": { schema: z.string().describe("Raw JPEG bytes.") },
            "image/png": { schema: z.string().describe("Raw PNG bytes.") },
            "image/webp": { schema: z.string().describe("Raw WebP bytes.") },
          },
        },
        "403": {
          description: "Caller is not the avatar's owner.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "404": {
          description: "The user has no uploaded avatar.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/user/profile": {
    get: {
      tags: ["Auth"],
      summary: "Read the calling user's profile",
      description:
        "Flattened profile fields for the native client. Aliased over the same data exposed by /api/auth/me. The KVNR is decrypted server-side; the IKNR (v1.8.6) is returned plaintext.",
      responses: {
        "200": {
          description: "The calling user's profile.",
          content: {
            "application/json": {
              schema: dataEnvelope(profileResponse, "GetProfileResponse"),
            },
          },
        },
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Auth"],
      summary: "Update the calling user's profile",
      description:
        "Partial profile update — every field is optional. An explicit null (or empty string) clears a field. A non-empty `insurerIkNumber` must be exactly 9 digits (422 otherwise); a non-empty `insuranceNumber` (KVNR) must pass the mod-10 check. `userId` is never accepted from the body.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: profileUpdateRequest } },
      },
      responses: {
        "200": {
          description: "Saved profile echoed back.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                profileUpdateResponse,
                "PatchProfileResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
};
