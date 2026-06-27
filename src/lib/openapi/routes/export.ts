/**
 * OpenAPI route table — generic data export (passphrase-encrypted variant).
 *
 * The plaintext `GET /api/export/full-backup` + per-type CSV routes predate the
 * OpenAPI registry and are not iOS-contract surfaces; this module documents the
 * v1.23 passphrase-encrypted variant because it adds a request flag + a binary
 * response shape the iOS client may consume.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";
import { stdResponses } from "./shared";

const encryptedExportRequest = z
  .object({
    passphrase: z.string().min(12).max(1024).meta({
      description:
        "User-chosen passphrase (>= 12 chars). Derives the archive key via Argon2id; never stored, never logged, no server-side recovery.",
    }),
  })
  .meta({ id: "EncryptedExportRequest" });

export const exportPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/export/encrypted": {
    post: {
      tags: ["Export"],
      summary: "Download the full backup as a passphrase-encrypted archive",
      description:
        "v1.23. Same restore-compatible payload as the plaintext full backup, sealed into an `HLX1` archive (Argon2id-derived key + AES-256-GCM) under the supplied `passphrase`. Returns `application/octet-stream` (a `.hlx` file). When the account has a second factor enrolled, the call is step-up gated (`requireFreshMfa`, cookie-only) and returns 401 `auth.stepup.required` without a fresh factor; single-factor accounts use a normal session or Bearer. Shared `export:<userId>` rate bucket (10/h). The passphrase is never stored — a forgotten passphrase makes the archive unrecoverable.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: encryptedExportRequest },
        },
      },
      responses: {
        "200": {
          description:
            "Encrypted archive. `application/octet-stream`; the body is the `HLX1` binary (magic | version | Argon2 params | salt | iv | tag | ciphertext).",
          content: {
            "application/octet-stream": {
              schema: z.string().meta({ format: "binary" }),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
};
