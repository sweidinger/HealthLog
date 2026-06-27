/**
 * OpenAPI route table — auth surface (login, passkey verify, token refresh).
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 * Schemas come from `src/lib/validations/*` where shared with the
 * runtime request parsing, so the wire contract stays single-source.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";
import { loginPasswordSchema } from "@/lib/validations/auth";
import {
  mfaVerifySchema,
  totpConfirmSchema,
  mfaDisableSchema,
} from "@/lib/validations/mfa";
import { dataEnvelope, stdResponses, errorEnvelope } from "./shared";

// ── Sub-schemas owned here (route-specific shapes) ───────────────────

const passkeyLoginVerifyRequest = z
  .object({
    challengeId: z
      .string()
      .min(1)
      .describe("Server-issued WebAuthn challenge id."),
    credential: z
      .object({
        id: z.string(),
        rawId: z.string(),
        type: z.literal("public-key"),
        response: z.record(z.string(), z.unknown()),
        authenticatorAttachment: z
          .enum(["platform", "cross-platform"])
          .optional(),
        clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
      })
      .describe("SimpleWebAuthn-style assertion response payload."),
  })
  .meta({
    id: "PasskeyLoginVerifyRequest",
    description:
      "Passkey assertion verification. Same native-client token issuance as the password path.",
  });

const refreshRequest = z
  .object({
    refreshToken: z
      .string()
      .min(1)
      .describe("Caller-presented refresh token (`hlr_<64hex>`)."),
    revoke: z
      .boolean()
      .optional()
      .describe("When true, revoke the supplied token instead of rotating."),
  })
  .meta({
    id: "RefreshTokenRequest",
    description:
      "Exchange a one-time-use refresh token for a fresh access + refresh pair.",
  });

const accessRefreshBundle = z
  .object({
    user: z.object({ id: z.string(), username: z.string() }).optional(),
    token: z.string().describe("Access token (`hlk_<64hex>`)."),
    tokenExpiresAt: z.iso.datetime({ offset: true }),
    refreshToken: z
      .string()
      .optional()
      .describe(
        "Refresh token (`hlr_<64hex>`); only present for native-policy callers.",
      ),
    refreshTokenExpiresAt: z.iso.datetime({ offset: true }).optional(),
  })
  .meta({
    id: "AccessRefreshBundle",
    description:
      "Native-client token bundle returned by login + refresh. Web cookie-only callers see only `user`.",
  });

// ── v1.23 second-factor (MFA) shapes ─────────────────────────────────

const mfaRequiredEnvelope = z
  .object({
    data: z.null(),
    error: z.null(),
    meta: z.object({
      mfaRequired: z.literal(true),
      mfaTicket: z
        .string()
        .describe(
          "Opaque, single-use, ~5-minute ticket to present to /api/auth/mfa/verify.",
        ),
      methods: z
        .array(z.enum(["totp", "recovery"]))
        .describe(
          "Second factors the account can complete the challenge with.",
        ),
    }),
  })
  .meta({
    id: "MfaRequiredResponse",
    description:
      "Password accepted but a second factor is required. Not an error and not a session — no token is issued until /api/auth/mfa/verify succeeds.",
  });

const totpSetupResponse = z
  .object({
    otpauthUri: z
      .string()
      .describe("otpauth:// URI to render as a QR code (carries the secret)."),
    totpSecret: z
      .string()
      .describe("Base32 secret for manual entry. Pending until confirmed."),
  })
  .meta({ id: "TotpSetupResponse" });

const recoveryCodesResponse = z
  .object({
    enabled: z.boolean().optional(),
    recoveryCodes: z
      .array(z.string())
      .describe("Single-use recovery codes, shown once. Save them now."),
    recoveryCodesRemaining: z.number().int(),
  })
  .meta({ id: "MfaRecoveryCodesResponse" });

const mfaToggleResponse = z
  .object({ enabled: z.boolean() })
  .meta({ id: "MfaToggleResponse" });

// ── v1.23 active sessions + security activity shapes ──────────────────

const sessionListResponse = z
  .object({
    sessions: z.array(
      z.object({
        id: z.string(),
        device: z
          .string()
          .describe("Coarse device label derived from the User-Agent."),
        ipMasked: z
          .string()
          .nullable()
          .describe(
            "IP with the host portion masked — never the full address.",
          ),
        location: z
          .string()
          .nullable()
          .describe("Resolved coarse location, when available."),
        lastActiveAt: z.iso.datetime({ offset: true }).nullable(),
        createdAt: z.iso.datetime({ offset: true }),
        isCurrent: z
          .boolean()
          .describe("True for the session making this request."),
      }),
    ),
  })
  .meta({ id: "SessionListResponse" });

const signOutEverywhereResponse = z
  .object({
    sessionsRevoked: z
      .number()
      .int()
      .describe("Number of OTHER sessions removed (the current one is kept)."),
  })
  .meta({ id: "SignOutEverywhereResponse" });

const securityActivityResponse = z
  .object({
    events: z.array(
      z.object({
        action: z
          .string()
          .describe("Audit action name, e.g. auth.login.password."),
        createdAt: z.iso.datetime({ offset: true }),
        location: z.string().nullable(),
        ipMasked: z.string().nullable().describe("Host-masked IP."),
        carrier: z.string().nullable(),
      }),
    ),
  })
  .meta({ id: "SecurityActivityResponse" });

export const authPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/auth/login": {
    post: {
      tags: ["Auth"],
      summary: "Email-or-username login (password)",
      description:
        "Browser callers receive a session cookie. Native callers (X-Client-Type: native or HealthLog-iOS UA prefix) additionally receive a paired access + refresh token.\n\n" +
        "v1.23 — when the account has a confirmed second factor, the response carries no session/token. It returns HTTP 200 with `data: null, error: null` and `meta.mfaRequired: true` plus a single-use `meta.mfaTicket` and the `meta.methods` list. The client must POST the ticket + a code to `/api/auth/mfa/verify` to obtain the token bundle. Accounts without MFA are unchanged.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: loginPasswordSchema } },
      },
      responses: {
        "200": {
          description:
            "Login succeeded (token bundle / cookie) — or a second factor is required (`meta.mfaRequired`).",
          content: {
            "application/json": {
              schema: z.union([
                dataEnvelope(accessRefreshBundle, "LoginResponse"),
                mfaRequiredEnvelope,
              ]),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/mfa/verify": {
    post: {
      tags: ["Auth"],
      summary: "Complete a second-factor login challenge",
      description:
        "Presents the `mfaTicket` from the login `meta.mfaRequired` response plus a TOTP or recovery code. On success returns the SAME token bundle / session the password path issues, with the session marked second-factor-verified. The ticket is single-use; wrong codes are throttled and the ticket is burned at the attempt cap.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: mfaVerifySchema } },
      },
      responses: {
        "200": {
          description:
            "Second factor verified — session + optional bearer issued.",
          content: {
            "application/json": {
              schema: dataEnvelope(accessRefreshBundle, "MfaVerifyResponse"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/mfa/totp/setup": {
    post: {
      tags: ["Auth"],
      summary: "Begin TOTP enrollment (cookie session only)",
      description:
        "Generates and stores a pending (encrypted) TOTP secret and returns the otpauth URI + Base32 secret. MFA is not active until /confirm. Cookie-only — a Bearer token cannot enrol MFA.",
      responses: {
        "200": {
          description: "Pending secret created.",
          content: {
            "application/json": {
              schema: dataEnvelope(totpSetupResponse, "TotpSetupEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/mfa/totp/confirm": {
    post: {
      tags: ["Auth"],
      summary: "Confirm TOTP enrollment (cookie session only)",
      description:
        "Verifies a code against the pending secret, activates the factor, and returns the one-time recovery codes. Cookie-only.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: totpConfirmSchema } },
      },
      responses: {
        "200": {
          description: "Factor activated — recovery codes returned once.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                recoveryCodesResponse,
                "TotpConfirmEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/mfa/disable": {
    post: {
      tags: ["Auth"],
      summary: "Disable the second factor (step-up gated)",
      description:
        "Requires a fresh second-factor step-up (cookie session) AND a current TOTP or recovery code. Clears the secret and deletes recovery codes. Bearer can never satisfy the step-up gate.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: mfaDisableSchema } },
      },
      responses: {
        "200": {
          description: "Factor disabled.",
          content: {
            "application/json": {
              schema: dataEnvelope(mfaToggleResponse, "MfaDisableEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/mfa/recovery-codes/regenerate": {
    post: {
      tags: ["Auth"],
      summary: "Regenerate recovery codes (step-up gated)",
      description:
        "Invalidates the entire prior recovery-code set and returns a fresh batch once. Step-up gated; Bearer can never satisfy the gate.",
      responses: {
        "200": {
          description: "Fresh recovery codes issued.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                recoveryCodesResponse,
                "MfaRecoveryRegenEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/passkey/login-verify": {
    post: {
      tags: ["Auth"],
      summary: "Passkey assertion verification",
      requestBody: {
        required: true,
        content: { "application/json": { schema: passkeyLoginVerifyRequest } },
      },
      responses: {
        "200": {
          description: "Assertion verified — session + optional bearer issued.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                accessRefreshBundle,
                "PasskeyLoginVerifyResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/refresh": {
    post: {
      tags: ["Auth"],
      summary: "Rotate refresh token (one-time use)",
      description:
        "Reuse of a consumed refresh token revokes every refresh token still active for the originating device (per-device blast radius from v1.4.23). Legacy tokens issued before v1.4.23 with a null deviceId fall back to revoke-all-for-user.\n\n" +
        "On a 401, `meta.errorCode` is a stable machine code so the client can branch terminal re-auth from a transient blip without parsing the prose `error`: `auth.refresh.reuse` (a consumed token was replayed — device family revoked, re-pair required), `auth.refresh.revoked` (family revoked out-of-band — re-pair required), `auth.refresh.invalid` (not found / expired — drop the token and re-authenticate).",
      requestBody: {
        required: true,
        content: { "application/json": { schema: refreshRequest } },
      },
      responses: {
        "200": {
          description: "Rotation succeeded — new pair issued.",
          content: {
            "application/json": {
              schema: dataEnvelope(accessRefreshBundle, "RefreshResponse"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/sessions": {
    get: {
      tags: ["Auth"],
      summary: "List active web sessions",
      description:
        "v1.23 — the user-facing active-session list (issue #64). One row per browser login with a coarse device label, masked IP, resolved location, sliding last-active time, and the current-session marker. Distinct from /api/auth/me/devices (notification devices).",
      responses: {
        "200": {
          description: "Active sessions for the caller.",
          content: {
            "application/json": {
              schema: dataEnvelope(sessionListResponse, "SessionListEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Auth"],
      summary: "Sign out everywhere else",
      description:
        "v1.23 — revokes every OTHER web session plus all native refresh tokens, keeping the caller's current session. API tokens are not touched (manage those under /settings/api-tokens).",
      responses: {
        "200": {
          description: "Other sessions revoked.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                signOutEverywhereResponse,
                "SignOutEverywhereEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/sessions/{id}": {
    delete: {
      tags: ["Auth"],
      summary: "Revoke a single web session",
      description:
        "v1.23 — revokes one session by id, scoped to the authenticated user (a foreign id returns 404, never another user's row).",
      responses: {
        "200": {
          description: "Session revoked.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ revoked: z.boolean() }),
                "SessionRevokeEnvelope",
              ),
            },
          },
        },
        "404": {
          description: "Session not found or not owned by the caller.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/security-activity": {
    get: {
      tags: ["Auth"],
      summary: "List recent account-security activity",
      description:
        "v1.23 — the SHARED security-activity feed: the caller's recent auth + export + deletion audit events with timestamp, resolved location, and a host-masked IP. `limit` query param caps at 100 (default 50). Reuses the AuditLog store; no event detail bodies are surfaced.",
      responses: {
        "200": {
          description: "Recent security events for the caller.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                securityActivityResponse,
                "SecurityActivityEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
};
