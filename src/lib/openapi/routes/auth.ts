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
  mfaWebauthnRegisterVerifySchema,
  mfaWebauthnRenameSchema,
  mfaWebauthnLoginOptionsSchema,
  mfaWebauthnLoginVerifySchema,
} from "@/lib/validations/mfa";
import { oidcNativeTokenSchema } from "@/lib/validations/oidc-native";
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
        .array(z.enum(["totp", "recovery", "webauthn"]))
        .describe(
          "Second factors the account can complete the challenge with. `webauthn` is completed via /api/auth/mfa/webauthn/verify; the rest via /api/auth/mfa/verify.",
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

const trustedDeviceListResponse = z
  .object({
    devices: z.array(
      z.object({
        id: z.string(),
        label: z
          .string()
          .nullable()
          .describe("Coarse, IP-free device label (e.g. 'Firefox on macOS')."),
        createdAt: z.iso.datetime({ offset: true }),
        lastUsedAt: z.iso.datetime({ offset: true }),
        expiresAt: z.iso.datetime({ offset: true }),
        isCurrent: z
          .boolean()
          .describe("True for the device making this request."),
      }),
    ),
  })
  .meta({ id: "TrustedDeviceListResponse" });

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

// ── v1.23 WebAuthn second-factor + status shapes ─────────────────────

const webauthnCredentialInfo = z
  .object({
    id: z.string(),
    name: z.string(),
    createdAt: z.iso.datetime({ offset: true }),
    lastUsedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .meta({ id: "WebauthnMfaCredentialInfo" });

const mfaStatusResponse = z
  .object({
    totp: z.object({ enabled: z.boolean() }),
    recoveryCodesRemaining: z.number().int(),
    webauthn: z.array(webauthnCredentialInfo),
    passkeyNudgeDismissed: z.boolean(),
  })
  .meta({ id: "MfaStatusResponse" });

const webauthnOptionsResponse = z
  .object({
    options: z
      .record(z.string(), z.unknown())
      .describe("SimpleWebAuthn options to pass to the browser ceremony."),
    challengeId: z.string().describe("Server-issued challenge id."),
  })
  .meta({ id: "WebauthnOptionsResponse" });

const successFlagResponse = z
  .object({ success: z.boolean() })
  .meta({ id: "AuthSuccessFlagResponse" });

// ── iOS onboarding discovery (check-user) ────────────────────────────

const checkUserRequest = z
  .object({
    identifier: z
      .string()
      .trim()
      .min(1)
      .max(254)
      .describe(
        "The typed identifier — either an email or a username. Queried verbatim (no case-folding), never echoed back.",
      ),
  })
  .meta({
    id: "CheckUserRequest",
    description:
      "Discovery lookup for the iOS onboarding flow: given a typed email or username, resolve the next sign-in step.",
  });

const checkUserResponse = z
  .object({
    branch: z
      .enum(["not_found", "passkey_only", "email_fallback", "exists"])
      .describe(
        "Next UX step: `not_found` (show sign-up), `passkey_only` (Sign in with Passkey), `email_fallback` (password field, with a Passkey affordance when applicable), `exists` (account with no usable credential — recovery path).",
      ),
    hasPasskey: z
      .boolean()
      .describe("The account has at least one registered passkey."),
    hasPassword: z.boolean().describe("The account has a password hash."),
  })
  .meta({
    id: "CheckUserResponse",
    description:
      "Account-existence + credential shape. The response is identical whether or not the identifier matched (account-existence is the explicit contract iOS needs); the identifier is never echoed.",
  });

export const authPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/auth/check-user": {
    post: {
      tags: ["Auth"],
      summary: "Resolve the next sign-in step for a typed identifier",
      description:
        "Given an email or username, returns which onboarding branch the iOS client should render plus the `hasPasskey` / `hasPassword` booleans so it can offer a Passkey affordance alongside a password field without a second round-trip. Anonymous surface; per-IP rate-limited (30 requests / 15 min). The response is the same whether or not the identifier matched, and the identifier is never echoed back.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: checkUserRequest } },
      },
      responses: {
        "200": {
          description: "Discovery result.",
          content: {
            "application/json": {
              schema: dataEnvelope(checkUserResponse, "CheckUserEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
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
  "/api/auth/oidc/native/token": {
    post: {
      tags: ["Auth"],
      summary: "Exchange a native OIDC handoff code for the token bundle",
      description:
        "The cookie-less native leg of the OIDC SSO flow. The iOS app opens `GET /api/auth/oidc/login?client=native&code_challenge=<S256>` inside an `ASWebAuthenticationSession`; the callback returns a one-time handoff code on `healthlog://oidc-callback?code=hlh_…` (or an `mfa_ticket` when the account has a second factor, completed at /api/auth/mfa/verify). This endpoint exchanges the code + its PKCE `codeVerifier` for the SAME native bundle password login issues.\n\n" +
        "Requires the native transport (no cookie, non-browser UA) — a browser is rejected. The code is single-use and expires in ~90 seconds; a replay of a consumed code revokes the pair the first exchange issued. A single generic 401 covers every invalid/expired/used/PKCE-mismatch case.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: oidcNativeTokenSchema } },
      },
      responses: {
        "200": {
          description: "Handoff accepted — native access + refresh bundle.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                accessRefreshBundle,
                "OidcNativeTokenResponse",
              ),
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
  "/api/auth/me/mfa": {
    get: {
      tags: ["Auth"],
      summary: "Second-factor status (cookie session only)",
      description:
        "Whether TOTP is active, how many recovery codes remain, and the registered WebAuthn security keys. Metadata only — no secret, code, or public key. Cookie-only.",
      responses: {
        "200": {
          description: "Second-factor status.",
          content: {
            "application/json": {
              schema: dataEnvelope(mfaStatusResponse, "MfaStatusEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/mfa/webauthn/register/options": {
    post: {
      tags: ["Auth"],
      summary: "Begin registering a security key as a second factor",
      description:
        "Returns SimpleWebAuthn creation options + a challenge id. Cookie-only — a Bearer token cannot enrol MFA.",
      responses: {
        "200": {
          description: "Registration options issued.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                webauthnOptionsResponse,
                "MfaWebauthnRegisterOptionsEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/mfa/webauthn/register/verify": {
    post: {
      tags: ["Auth"],
      summary: "Finish registering a security key as a second factor",
      description:
        "Verifies the attestation against the user-bound challenge and stores the credential in the second-factor store (separate from primary passkeys). Cookie-only.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: mfaWebauthnRegisterVerifySchema },
        },
      },
      responses: {
        "200": {
          description: "Security key registered.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                webauthnCredentialInfo,
                "MfaWebauthnRegisterVerifyEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/mfa/webauthn/{id}": {
    patch: {
      tags: ["Auth"],
      summary: "Rename a registered security key",
      requestBody: {
        required: true,
        content: { "application/json": { schema: mfaWebauthnRenameSchema } },
      },
      responses: {
        "200": {
          description: "Security key renamed.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                webauthnCredentialInfo,
                "MfaWebauthnRenameEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Auth"],
      summary: "Remove a registered security key (step-up gated)",
      description:
        "Requires a fresh second-factor step-up (cookie session). Bearer can never satisfy the gate.",
      responses: {
        "200": {
          description: "Security key removed.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                successFlagResponse,
                "MfaWebauthnRemoveEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/mfa/webauthn/verify/options": {
    post: {
      tags: ["Auth"],
      summary: "Begin a mid-login security-key assertion",
      description:
        "Presents the login `mfaTicket` and returns assertion options scoped to the password-identified user's registered security keys. Anonymous surface; rate-limited.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: mfaWebauthnLoginOptionsSchema },
        },
      },
      responses: {
        "200": {
          description: "Assertion options issued.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                webauthnOptionsResponse,
                "MfaWebauthnLoginOptionsEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/mfa/webauthn/verify": {
    post: {
      tags: ["Auth"],
      summary: "Complete a security-key second-factor login challenge",
      description:
        "Presents the login `mfaTicket` plus the assertion. On success returns the SAME token bundle / session the password path issues, with the session marked second-factor-verified. The ticket is single-use; failures are throttled and the ticket is burned at the attempt cap.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: mfaWebauthnLoginVerifySchema },
        },
      },
      responses: {
        "200": {
          description:
            "Second factor verified — session + optional bearer issued.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                accessRefreshBundle,
                "MfaWebauthnVerifyResponse",
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
  "/api/auth/me/trusted-devices": {
    get: {
      tags: ["Auth"],
      summary: "List trusted devices",
      description:
        "v1.23 — the 'remember this device' list. A trusted device skips the second factor for 30 days (the password is still required). Returns only an IP-free device label + lifecycle timestamps, never the token.",
      responses: {
        "200": {
          description: "Trusted devices for the caller.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                trustedDeviceListResponse,
                "TrustedDeviceListEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Auth"],
      summary: "Forget every trusted device",
      description:
        "v1.23 — revokes all trusted devices for the caller and clears the caller's own trusted-device cookie.",
      responses: {
        "200": {
          description: "All trusted devices revoked.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ revoked: z.number().int() }),
                "TrustedDeviceRevokeAllEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/trusted-devices/{id}": {
    delete: {
      tags: ["Auth"],
      summary: "Revoke a single trusted device",
      description:
        "v1.23 — revokes one trusted device by id, scoped to the authenticated user (a foreign id returns 404).",
      responses: {
        "200": {
          description: "Trusted device revoked.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ revoked: z.boolean() }),
                "TrustedDeviceRevokeEnvelope",
              ),
            },
          },
        },
        "404": {
          description: "Trusted device not found or not owned by the caller.",
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
