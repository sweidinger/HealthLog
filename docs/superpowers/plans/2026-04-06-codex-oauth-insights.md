# Codex OAuth + Medical Insights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace OpenAI API-key flow with ChatGPT Codex OAuth, add admin AI key fallback, and improve medical insight prompts with guideline-based analysis.

**Architecture:** Provider abstraction layer (`src/lib/ai/`) with Codex OAuth client and standard OpenAI client. Provider hierarchy: User Codex OAuth → Admin key → local fallback. Each insight generator delegates to `resolveProvider()` instead of directly calling OpenAI. New Prisma fields for Codex tokens + admin AI settings. OAuth flow follows existing Withings pattern.

**Tech Stack:** Next.js 16, Prisma 7, PostgreSQL, TypeScript strict, Vitest, Zod v4, AES-256-GCM encryption, OAuth 2.1 + PKCE

**Spec:** `docs/superpowers/specs/2026-04-06-codex-oauth-insights-design.md`

---

## Phase 1: Core AI Provider Abstraction

### Task 1: Prisma Schema Changes

**Files:**
- Modify: `prisma/schema.prisma` (User model lines 12-71, AppSettings model lines 352-378)

- [ ] **Step 1: Add new fields to User model**

In `prisma/schema.prisma`, replace the `openaiKeyEncrypted` line in the User model:

```prisma
  // Codex OAuth (ChatGPT subscription)
  codexAccessTokenEncrypted   String?   @map("codex_access_token_encrypted")
  codexRefreshTokenEncrypted  String?   @map("codex_refresh_token_encrypted")
  codexTokenExpiresAt         DateTime? @map("codex_token_expires_at")
  codexConnectedAt            DateTime? @map("codex_connected_at")
  codexConnectionStatus       String    @default("disconnected") @map("codex_connection_status")

  // Insights
  insightsPrivacyMode String   @default("aggregated") @map("insights_privacy_mode")
  insightsCachedAt    DateTime? @map("insights_cached_at")
  insightsCachedText  String?  @map("insights_cached_text")
```

Remove the old `openaiKeyEncrypted` line.

- [ ] **Step 2: Add admin AI fields to AppSettings**

Add at the end of the AppSettings model:

```prisma
  // Admin AI Provider (fallback for users without Codex OAuth)
  adminAiKeyEncrypted   String? @map("admin_ai_key_encrypted")
  adminAiModel          String  @default("gpt-4o-mini") @map("admin_ai_model")
  adminAiBaseUrl        String  @default("https://api.openai.com/v1") @map("admin_ai_base_url")
```

- [ ] **Step 3: Create and apply migration**

```bash
cd ~/projects/HealthLog
pnpm db:migrate --name codex-oauth-admin-ai
```

- [ ] **Step 4: Generate Prisma client**

```bash
pnpm db:generate
```

- [ ] **Step 5: Verify build compiles**

```bash
pnpm typecheck
```

Expected: Errors in files that reference `openaiKeyEncrypted` — these will be fixed in subsequent tasks.

- [ ] **Step 6: Commit**

```bash
git add prisma/ src/generated/
git commit -m "feat(db): add Codex OAuth tokens and admin AI settings, remove openaiKeyEncrypted"
```

---

### Task 2: AI Types & Zod Schema

**Files:**
- Create: `src/lib/ai/types.ts`

- [ ] **Step 1: Write the types file**

```typescript
import { z } from "zod/v4";

// ─── Insight Result Schema ─────────────────────────────────

export const insightFindingSchema = z.object({
  label: z.string(),
  value: z.string(),
  assessment: z.enum(["positive", "neutral", "attention", "warning"]),
  guideline: z.string().optional(),
});

export const insightCorrelationSchema = z.object({
  factor: z.string(),
  effect: z.string(),
  confidence: z.enum(["hoch", "mittel", "gering"]),
});

export const insightDataQualitySchema = z.object({
  coverage: z.string(),
  gaps: z.array(z.string()),
  confidence: z.enum(["hoch", "mittel", "gering"]),
});

export const insightResultSchema = z.object({
  summary: z.string(),
  classification: z.enum(["optimal", "gut", "grenzwertig", "erhoht", "kritisch"]),
  findings: z.array(insightFindingSchema),
  correlations: z.array(insightCorrelationSchema),
  recommendations: z.array(z.string()),
  dataQuality: insightDataQualitySchema,
  disclaimer: z.string(),
});

export type InsightResult = z.infer<typeof insightResultSchema>;
export type InsightFinding = z.infer<typeof insightFindingSchema>;

// ─── Provider Types ────────────────────────────────────────

export type ProviderType = "codex" | "admin-key" | "none";

export interface AIProvider {
  type: ProviderType;
  generateCompletion(params: CompletionParams): Promise<CompletionResult>;
}

export interface CompletionParams {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
}

export interface CompletionResult {
  content: string;
  tokensUsed: number | null;
  model: string;
  providerType: ProviderType;
}

// ─── Legacy Output (for migration compatibility) ───────────

export interface LegacyInsightsOutput {
  changed: string;
  stable: string;
  drivers: string;
  nextSteps: string;
  confidence: "niedrig" | "mittel" | "hoch";
  limitations: string;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/ai/types.ts
git commit -m "feat(ai): add AI provider types and InsightResult Zod schema"
```

---

### Task 3: OpenAI Client (Admin Key)

**Files:**
- Create: `src/lib/ai/openai-client.ts`
- Test: `src/lib/ai/__tests__/openai-client.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenAIClient } from "../openai-client";

describe("OpenAIClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends correct request format", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: '{"summary":"test"}' } }],
          usage: { total_tokens: 42 },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new OpenAIClient({
      apiKey: "sk-test-key",
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
    });

    const result = await client.generateCompletion({
      systemPrompt: "You are a doctor.",
      userPrompt: "Analyze this data.",
    });

    expect(result.content).toBe('{"summary":"test"}');
    expect(result.tokensUsed).toBe(42);
    expect(result.model).toBe("gpt-4o-mini");
    expect(result.providerType).toBe("admin-key");

    const call = mockFetch.mock.calls[0];
    expect(call[0]).toBe("https://api.openai.com/v1/chat/completions");
    const body = JSON.parse(call[1].body);
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.messages).toHaveLength(2);
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("throws on non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: () => Promise.resolve("rate limited"),
      }),
    );

    const client = new OpenAIClient({
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
    });

    await expect(
      client.generateCompletion({
        systemPrompt: "test",
        userPrompt: "test",
      }),
    ).rejects.toThrow("OpenAI request failed (429)");
  });

  it("uses custom base URL for OpenRouter", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: '{"test":true}' } }],
          usage: { total_tokens: 10 },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new OpenAIClient({
      apiKey: "sk-or-test",
      model: "openai/gpt-4o-mini",
      baseUrl: "https://openrouter.ai/api/v1",
    });

    await client.generateCompletion({
      systemPrompt: "test",
      userPrompt: "test",
    });

    expect(mockFetch.mock.calls[0][0]).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test src/lib/ai/__tests__/openai-client.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
import type { AIProvider, CompletionParams, CompletionResult } from "./types";

interface OpenAIClientConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
}

export class OpenAIClient implements AIProvider {
  readonly type = "admin-key" as const;
  private config: OpenAIClientConfig;

  constructor(config: OpenAIClientConfig) {
    this.config = config;
  }

  async generateCompletion(params: CompletionParams): Promise<CompletionResult> {
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          { role: "system", content: params.systemPrompt },
          { role: "user", content: params.userPrompt },
        ],
        temperature: params.temperature ?? 0.3,
        max_tokens: params.maxTokens ?? 1000,
        response_format: { type: "json_object" },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI request failed (${res.status}): ${body}`);
    }

    const json = await res.json();
    const content = json.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error("OpenAI returned empty content");
    }

    return {
      content,
      tokensUsed: json.usage?.total_tokens ?? null,
      model: this.config.model,
      providerType: "admin-key",
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test src/lib/ai/__tests__/openai-client.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/openai-client.ts src/lib/ai/__tests__/openai-client.test.ts
git commit -m "feat(ai): add OpenAI client with custom base URL support"
```

---

### Task 4: Codex OAuth Utilities

**Files:**
- Create: `src/lib/ai/codex-oauth.ts`
- Test: `src/lib/ai/__tests__/codex-oauth.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { generatePKCE, buildAuthorizationUrl } from "../codex-oauth";

describe("codex-oauth", () => {
  describe("generatePKCE", () => {
    it("generates verifier of correct length", () => {
      const { verifier, challenge } = generatePKCE();
      // Base64url of 96 bytes = 128 chars
      expect(verifier.length).toBeGreaterThanOrEqual(43);
      expect(challenge.length).toBeGreaterThanOrEqual(43);
      // No padding chars
      expect(verifier).not.toContain("=");
      expect(challenge).not.toContain("=");
    });

    it("generates different values each time", () => {
      const a = generatePKCE();
      const b = generatePKCE();
      expect(a.verifier).not.toBe(b.verifier);
    });
  });

  describe("buildAuthorizationUrl", () => {
    it("builds correct URL with all params", () => {
      const url = buildAuthorizationUrl({
        codeChallenge: "test-challenge",
        state: "test-state",
        redirectUri: "https://example.com/callback",
      });

      const parsed = new URL(url);
      expect(parsed.origin).toBe("https://chatgpt.com");
      expect(parsed.pathname).toBe("/authorize");
      expect(parsed.searchParams.get("response_type")).toBe("code");
      expect(parsed.searchParams.get("code_challenge")).toBe("test-challenge");
      expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
      expect(parsed.searchParams.get("state")).toBe("test-state");
      expect(parsed.searchParams.get("redirect_uri")).toBe(
        "https://example.com/callback",
      );
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test src/lib/ai/__tests__/codex-oauth.test.ts
```

- [ ] **Step 3: Write implementation**

```typescript
import { createHash, randomBytes } from "node:crypto";
import { encrypt, decrypt } from "@/lib/crypto";

function base64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

export function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(96));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function generateState(): string {
  return base64url(randomBytes(32));
}

export function buildAuthorizationUrl(params: {
  codeChallenge: string;
  state: string;
  redirectUri: string;
}): string {
  const url = new URL("https://chatgpt.com/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", params.state);
  url.searchParams.set("redirect_uri", params.redirectUri);
  return url.toString();
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

export async function exchangeCodeForTokens(params: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<TokenResponse> {
  const res = await fetch("https://chatgpt.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: params.code,
      code_verifier: params.codeVerifier,
      redirect_uri: params.redirectUri,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Codex token exchange failed (${res.status}): ${body}`);
  }

  return res.json();
}

export async function refreshAccessToken(
  refreshToken: string,
): Promise<TokenResponse> {
  const res = await fetch("https://chatgpt.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Codex token refresh failed (${res.status}): ${body}`);
  }

  return res.json();
}

export function encryptTokens(tokens: {
  accessToken: string;
  refreshToken: string;
}): { accessEncrypted: string; refreshEncrypted: string } {
  return {
    accessEncrypted: encrypt(tokens.accessToken),
    refreshEncrypted: encrypt(tokens.refreshToken),
  };
}

export function decryptTokens(encrypted: {
  accessEncrypted: string;
  refreshEncrypted: string;
}): { accessToken: string; refreshToken: string } {
  return {
    accessToken: decrypt(encrypted.accessEncrypted),
    refreshToken: decrypt(encrypted.refreshEncrypted),
  };
}
```

- [ ] **Step 4: Run test**

```bash
pnpm test src/lib/ai/__tests__/codex-oauth.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/codex-oauth.ts src/lib/ai/__tests__/codex-oauth.test.ts
git commit -m "feat(ai): add Codex OAuth PKCE utilities and token management"
```

---

### Task 5: Codex Client

**Files:**
- Create: `src/lib/ai/codex-client.ts`
- Test: `src/lib/ai/__tests__/codex-client.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CodexClient } from "../codex-client";

describe("CodexClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends request to codex responses endpoint", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          output: [
            { type: "message", content: [{ type: "output_text", text: '{"summary":"ok"}' }] },
          ],
          usage: { total_tokens: 50 },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new CodexClient({
      accessToken: "test-token",
      onTokenRefresh: vi.fn(),
    });

    const result = await client.generateCompletion({
      systemPrompt: "You are a doctor.",
      userPrompt: "Analyze this.",
    });

    expect(result.content).toBe('{"summary":"ok"}');
    expect(result.providerType).toBe("codex");
    expect(mockFetch.mock.calls[0][0]).toBe(
      "https://chatgpt.com/backend-api/codex/responses",
    );
    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe("Bearer test-token");
  });

  it("calls onTokenRefresh on 401 and retries", async () => {
    const newToken = "refreshed-token";
    const onRefresh = vi.fn().mockResolvedValue(newToken);

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 401, text: () => Promise.resolve("unauthorized") })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            output: [
              { type: "message", content: [{ type: "output_text", text: '{"test":true}' }] },
            ],
            usage: { total_tokens: 10 },
          }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const client = new CodexClient({
      accessToken: "expired-token",
      onTokenRefresh: onRefresh,
    });

    const result = await client.generateCompletion({
      systemPrompt: "test",
      userPrompt: "test",
    });

    expect(onRefresh).toHaveBeenCalledOnce();
    expect(result.content).toBe('{"test":true}');
    // Second call uses refreshed token
    expect(mockFetch.mock.calls[1][1].headers.Authorization).toBe(
      `Bearer ${newToken}`,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test src/lib/ai/__tests__/codex-client.test.ts
```

- [ ] **Step 3: Write implementation**

```typescript
import type { AIProvider, CompletionParams, CompletionResult } from "./types";

const CODEX_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_MODEL = "gpt-5.3-codex";

interface CodexClientConfig {
  accessToken: string;
  onTokenRefresh: () => Promise<string>;
}

export class CodexClient implements AIProvider {
  readonly type = "codex" as const;
  private accessToken: string;
  private onTokenRefresh: () => Promise<string>;

  constructor(config: CodexClientConfig) {
    this.accessToken = config.accessToken;
    this.onTokenRefresh = config.onTokenRefresh;
  }

  async generateCompletion(params: CompletionParams): Promise<CompletionResult> {
    const result = await this.doRequest(params);

    // Retry once on 401 after refreshing token
    if (result.status === 401) {
      this.accessToken = await this.onTokenRefresh();
      return this.parseResponse(await this.doRequest(params, true));
    }

    return this.parseResponse(result);
  }

  private async doRequest(
    params: CompletionParams,
    isRetry = false,
  ): Promise<Response & { status: number }> {
    const res = await fetch(CODEX_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify({
        model: CODEX_MODEL,
        instructions: params.systemPrompt,
        input: params.userPrompt,
        stream: false,
      }),
    });

    if (!res.ok && res.status !== 401) {
      const body = await res.text();
      throw new Error(`Codex request failed (${res.status}): ${body}`);
    }

    if (!res.ok && res.status === 401 && isRetry) {
      throw new Error("Codex request failed after token refresh (401)");
    }

    return res as Response & { status: number };
  }

  private async parseResponse(res: Response): Promise<CompletionResult> {
    const json = await res.json();

    // Codex Responses API format
    const messageOutput = json.output?.find(
      (o: any) => o.type === "message",
    );
    const textContent = messageOutput?.content?.find(
      (c: any) => c.type === "output_text",
    );

    if (!textContent?.text) {
      throw new Error("Codex returned empty content");
    }

    return {
      content: textContent.text,
      tokensUsed: json.usage?.total_tokens ?? null,
      model: CODEX_MODEL,
      providerType: "codex",
    };
  }
}
```

- [ ] **Step 4: Run test**

```bash
pnpm test src/lib/ai/__tests__/codex-client.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/codex-client.ts src/lib/ai/__tests__/codex-client.test.ts
git commit -m "feat(ai): add Codex client with auto-refresh on 401"
```

---

### Task 6: Provider Resolution

**Files:**
- Create: `src/lib/ai/provider.ts`
- Test: `src/lib/ai/__tests__/provider.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock prisma before importing provider
vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    appSettings: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/crypto", () => ({
  decrypt: vi.fn((v: string) => `decrypted:${v}`),
  encrypt: vi.fn((v: string) => `encrypted:${v}`),
}));

import { resolveProvider } from "../provider";
import { prisma } from "@/lib/db";

describe("resolveProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns codex provider when user has valid tokens", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      codexAccessTokenEncrypted: "enc-access",
      codexRefreshTokenEncrypted: "enc-refresh",
      codexTokenExpiresAt: new Date(Date.now() + 3600000),
      codexConnectionStatus: "connected",
    } as any);

    const provider = await resolveProvider("user-123");
    expect(provider.type).toBe("codex");
  });

  it("returns admin-key when user has no codex but admin key exists", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      codexAccessTokenEncrypted: null,
      codexRefreshTokenEncrypted: null,
      codexTokenExpiresAt: null,
      codexConnectionStatus: "disconnected",
    } as any);

    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      adminAiKeyEncrypted: "enc-admin-key",
      adminAiModel: "gpt-4o-mini",
      adminAiBaseUrl: "https://api.openai.com/v1",
    } as any);

    const provider = await resolveProvider("user-123");
    expect(provider.type).toBe("admin-key");
  });

  it("returns none when nothing is configured", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      codexAccessTokenEncrypted: null,
      codexConnectionStatus: "disconnected",
    } as any);

    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      adminAiKeyEncrypted: null,
    } as any);

    const provider = await resolveProvider("user-123");
    expect(provider.type).toBe("none");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test src/lib/ai/__tests__/provider.test.ts
```

- [ ] **Step 3: Write implementation**

```typescript
import { prisma } from "@/lib/db";
import { decrypt, encrypt } from "@/lib/crypto";
import { CodexClient } from "./codex-client";
import { OpenAIClient } from "./openai-client";
import { refreshAccessToken, encryptTokens } from "./codex-oauth";
import type { AIProvider, CompletionParams, CompletionResult } from "./types";

class NoProvider implements AIProvider {
  readonly type = "none" as const;
  async generateCompletion(): Promise<CompletionResult> {
    throw new Error("No AI provider configured");
  }
}

export async function resolveProvider(userId: string): Promise<AIProvider> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      codexAccessTokenEncrypted: true,
      codexRefreshTokenEncrypted: true,
      codexTokenExpiresAt: true,
      codexConnectionStatus: true,
    },
  });

  // 1. Try Codex OAuth
  if (
    user?.codexAccessTokenEncrypted &&
    user.codexRefreshTokenEncrypted &&
    user.codexConnectionStatus === "connected"
  ) {
    let accessToken = decrypt(user.codexAccessTokenEncrypted);

    // Proactive refresh if token expires within 5 minutes
    if (
      user.codexTokenExpiresAt &&
      user.codexTokenExpiresAt.getTime() < Date.now() + 5 * 60 * 1000
    ) {
      try {
        const refreshToken = decrypt(user.codexRefreshTokenEncrypted);
        const tokens = await refreshAccessToken(refreshToken);
        const encrypted = encryptTokens({
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
        });

        await prisma.user.update({
          where: { id: userId },
          data: {
            codexAccessTokenEncrypted: encrypted.accessEncrypted,
            codexRefreshTokenEncrypted: encrypted.refreshEncrypted,
            codexTokenExpiresAt: new Date(
              Date.now() + tokens.expires_in * 1000,
            ),
          },
        });

        accessToken = tokens.access_token;
      } catch {
        // Proactive refresh failed, try with current token
      }
    }

    return new CodexClient({
      accessToken,
      onTokenRefresh: async () => {
        const current = await prisma.user.findUnique({
          where: { id: userId },
          select: { codexRefreshTokenEncrypted: true },
        });

        if (!current?.codexRefreshTokenEncrypted) {
          throw new Error("No refresh token available");
        }

        const refreshToken = decrypt(current.codexRefreshTokenEncrypted);
        const tokens = await refreshAccessToken(refreshToken);
        const encrypted = encryptTokens({
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
        });

        await prisma.user.update({
          where: { id: userId },
          data: {
            codexAccessTokenEncrypted: encrypted.accessEncrypted,
            codexRefreshTokenEncrypted: encrypted.refreshEncrypted,
            codexTokenExpiresAt: new Date(
              Date.now() + tokens.expires_in * 1000,
            ),
          },
        });

        return tokens.access_token;
      },
    });
  }

  // 2. Try admin key
  const settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
    select: {
      adminAiKeyEncrypted: true,
      adminAiModel: true,
      adminAiBaseUrl: true,
    },
  });

  if (settings?.adminAiKeyEncrypted) {
    return new OpenAIClient({
      apiKey: decrypt(settings.adminAiKeyEncrypted),
      model: settings.adminAiModel,
      baseUrl: settings.adminAiBaseUrl,
    });
  }

  // 3. No provider
  return new NoProvider();
}
```

- [ ] **Step 4: Run test**

```bash
pnpm test src/lib/ai/__tests__/provider.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/provider.ts src/lib/ai/__tests__/provider.test.ts
git commit -m "feat(ai): add provider resolution with codex → admin-key → none hierarchy"
```

---

## Phase 2: OAuth Routes & Settings

### Task 7: OAuth Authorize Route

**Files:**
- Create: `src/app/api/auth/codex/authorize/route.ts`

- [ ] **Step 1: Write the route**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { generatePKCE, generateState, buildAuthorizationUrl } from "@/lib/ai/codex-oauth";
import { cookies } from "next/headers";
import { annotate } from "@/lib/logging/context";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const { verifier, challenge } = generatePKCE();
  const state = generateState();

  const appUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) throw new Error("APP_URL not configured");

  const redirectUri = `${appUrl}/api/auth/codex/callback`;

  // Store PKCE verifier and state in short-lived cookies (5 min)
  const cookieStore = await cookies();
  const cookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 300,
  };

  cookieStore.set("codex_verifier", verifier, cookieOptions);
  cookieStore.set("codex_state", state, cookieOptions);

  const authUrl = buildAuthorizationUrl({
    codeChallenge: challenge,
    state,
    redirectUri,
  });

  annotate({ action: { name: "codex.oauth.authorize" } });

  return NextResponse.redirect(authUrl);
});
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/auth/codex/authorize/route.ts
git commit -m "feat(oauth): add Codex OAuth authorize endpoint with PKCE"
```

---

### Task 8: OAuth Callback Route

**Files:**
- Create: `src/app/api/auth/codex/callback/route.ts`

- [ ] **Step 1: Write the route**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { exchangeCodeForTokens, encryptTokens } from "@/lib/ai/codex-oauth";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { getClientIp } from "@/lib/api-response";
import { cookies } from "next/headers";
import { annotate } from "@/lib/logging/context";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  const url = new URL(request.url);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const appUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) throw new Error("APP_URL not configured");

  // Handle OAuth error
  if (error) {
    annotate({ meta: { oauth_error: error } });
    return NextResponse.redirect(
      `${appUrl}/settings?codex_error=${encodeURIComponent(error)}`,
    );
  }

  if (!code || !state) {
    return NextResponse.redirect(`${appUrl}/settings?codex_error=missing_params`);
  }

  // Validate state against cookie
  const cookieStore = await cookies();
  const storedState = cookieStore.get("codex_state")?.value;
  const storedVerifier = cookieStore.get("codex_verifier")?.value;

  // Clean up cookies immediately
  cookieStore.delete("codex_state");
  cookieStore.delete("codex_verifier");

  if (!storedState || !storedVerifier || state !== storedState) {
    return NextResponse.redirect(`${appUrl}/settings?codex_error=invalid_state`);
  }

  // Exchange code for tokens
  const redirectUri = `${appUrl}/api/auth/codex/callback`;

  try {
    const tokens = await exchangeCodeForTokens({
      code,
      codeVerifier: storedVerifier,
      redirectUri,
    });

    const encrypted = encryptTokens({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
    });

    await prisma.user.update({
      where: { id: user.id },
      data: {
        codexAccessTokenEncrypted: encrypted.accessEncrypted,
        codexRefreshTokenEncrypted: encrypted.refreshEncrypted,
        codexTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
        codexConnectedAt: new Date(),
        codexConnectionStatus: "connected",
        // Clear insight cache so new provider generates fresh insights
        insightsCachedAt: null,
        insightsCachedText: null,
      },
    });

    await auditLog("codex.oauth.connected", {
      userId: user.id,
      ipAddress: getClientIp(request),
    });

    annotate({ action: { name: "codex.oauth.callback.success" } });

    return NextResponse.redirect(`${appUrl}/settings?codex_connected=true`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    annotate({ meta: { codex_token_error: message } });
    return NextResponse.redirect(
      `${appUrl}/settings?codex_error=token_exchange_failed`,
    );
  }
});
```

- [ ] **Step 2: Add callback to PUBLIC_PATHS in proxy.ts**

In `src/proxy.ts`, add to the PUBLIC_PATHS array:

```typescript
  "/api/auth/codex/callback",
```

- [ ] **Step 3: Commit**

```bash
git add src/app/api/auth/codex/callback/route.ts src/proxy.ts
git commit -m "feat(oauth): add Codex OAuth callback with CSRF validation and token storage"
```

---

### Task 9: OAuth Disconnect Route

**Files:**
- Create: `src/app/api/auth/codex/disconnect/route.ts`

- [ ] **Step 1: Write the route**

```typescript
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess } from "@/lib/api-response";
import { getClientIp } from "@/lib/api-response";
import { NextRequest } from "next/server";
import { annotate } from "@/lib/logging/context";

export const DELETE = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  await prisma.user.update({
    where: { id: user.id },
    data: {
      codexAccessTokenEncrypted: null,
      codexRefreshTokenEncrypted: null,
      codexTokenExpiresAt: null,
      codexConnectedAt: null,
      codexConnectionStatus: "disconnected",
      insightsCachedAt: null,
      insightsCachedText: null,
    },
  });

  await auditLog("codex.oauth.disconnected", {
    userId: user.id,
    ipAddress: getClientIp(request),
  });

  annotate({ action: { name: "codex.oauth.disconnect" } });

  return apiSuccess({ disconnected: true });
});
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/auth/codex/disconnect/route.ts
git commit -m "feat(oauth): add Codex disconnect endpoint"
```

---

### Task 10: Admin AI Settings Route

**Files:**
- Create: `src/app/api/admin/ai-settings/route.ts`

- [ ] **Step 1: Write the route**

```typescript
import { prisma } from "@/lib/db";
import { apiSuccess, apiError, safeJson } from "@/lib/api-response";
import { encrypt, decrypt } from "@/lib/crypto";
import { NextRequest } from "next/server";
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";

export const GET = apiHandler(async () => {
  await requireAdmin();

  const settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
    select: {
      adminAiKeyEncrypted: true,
      adminAiModel: true,
      adminAiBaseUrl: true,
    },
  });

  annotate({ action: { name: "admin.ai-settings.get" } });

  return apiSuccess({
    hasKey: !!settings?.adminAiKeyEncrypted,
    keyPreview: settings?.adminAiKeyEncrypted
      ? `${decrypt(settings.adminAiKeyEncrypted).slice(0, 7)}...`
      : null,
    model: settings?.adminAiModel ?? "gpt-4o-mini",
    baseUrl: settings?.adminAiBaseUrl ?? "https://api.openai.com/v1",
  });
});

export const PUT = apiHandler(async (request: NextRequest) => {
  await requireAdmin();

  const { data: body, error: jsonError } = await safeJson<Record<string, unknown>>(request);
  if (jsonError) return jsonError;

  const data: Record<string, unknown> = {};

  if (typeof body.apiKey === "string") {
    const key = (body.apiKey as string).trim();
    if (key === "") {
      data.adminAiKeyEncrypted = null;
    } else {
      data.adminAiKeyEncrypted = encrypt(key);
    }
  }

  if (typeof body.model === "string") {
    data.adminAiModel = (body.model as string).trim();
  }

  if (typeof body.baseUrl === "string") {
    const url = (body.baseUrl as string).trim();
    if (url && !url.startsWith("https://")) {
      return apiError("Base URL must use HTTPS", 422);
    }
    data.adminAiBaseUrl = url || "https://api.openai.com/v1";
  }

  if (Object.keys(data).length === 0) {
    return apiError("No changes", 422);
  }

  await prisma.appSettings.upsert({
    where: { id: "singleton" },
    update: data,
    create: { id: "singleton", ...data },
  });

  annotate({ action: { name: "admin.ai-settings.update" } });

  return apiSuccess({ updated: true });
});
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/admin/ai-settings/route.ts
git commit -m "feat(admin): add AI settings route for admin key management"
```

---

## Phase 3: Update Insight Generators

### Task 11: Update insights/settings route

**Files:**
- Modify: `src/app/api/insights/settings/route.ts`

- [ ] **Step 1: Rewrite to use Codex status**

Replace the entire file with:

```typescript
import { prisma } from "@/lib/db";
import { apiSuccess, apiError, safeJson } from "@/lib/api-response";
import { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      codexConnectionStatus: true,
      codexConnectedAt: true,
      insightsPrivacyMode: true,
      insightsCachedAt: true,
    },
  });

  const settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
    select: { adminAiKeyEncrypted: true },
  });

  annotate({ action: { name: "insights.settings.get" } });

  return apiSuccess({
    codexStatus: dbUser?.codexConnectionStatus ?? "disconnected",
    codexConnectedAt: dbUser?.codexConnectedAt ?? null,
    hasAdminKey: !!settings?.adminAiKeyEncrypted,
    privacyMode: dbUser?.insightsPrivacyMode ?? "aggregated",
    lastInsightAt: dbUser?.insightsCachedAt ?? null,
  });
});

export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const { data: body, error: jsonError } = await safeJson<Record<string, unknown>>(request);
  if (jsonError) return jsonError;

  const data: Record<string, unknown> = {};

  if (typeof body.privacyMode === "string") {
    const mode = body.privacyMode as string;
    if (!["aggregated", "raw"].includes(mode)) {
      return apiError("Invalid privacy mode", 422);
    }
    data.insightsPrivacyMode = mode;
    data.insightsCachedAt = null;
    data.insightsCachedText = null;
  }

  if (Object.keys(data).length === 0) {
    return apiError("No changes", 422);
  }

  await prisma.user.update({
    where: { id: user.id },
    data,
  });

  annotate({ action: { name: "insights.settings.update" } });

  return apiSuccess({ updated: true });
});
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/insights/settings/route.ts
git commit -m "refactor(insights): update settings route for Codex OAuth status"
```

---

### Task 12: Update insights/generate route

**Files:**
- Modify: `src/app/api/insights/generate/route.ts`

- [ ] **Step 1: Rewrite to use provider abstraction**

Replace the entire file content. Key changes: use `resolveProvider()` instead of direct OpenAI fetch, validate output with Zod schema, use new InsightResult type.

```typescript
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { extractFeatures } from "@/lib/insights/features";
import { buildGeneratePrompts } from "@/lib/ai/prompts/general-status";
import { insightResultSchema, type InsightResult } from "@/lib/ai/types";
import { resolveProvider } from "@/lib/ai/provider";
import { checkRateLimit } from "@/lib/rate-limit";
import { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  const userId = user.id;

  const rl = await checkRateLimit(`insights:${userId}`, 2, 60 * 60 * 1000);
  if (!rl.allowed) {
    return apiError("Maximum 2 insight generations per hour.", 429);
  }

  const dbUser = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      insightsPrivacyMode: true,
      insightsCachedAt: true,
      insightsCachedText: true,
    },
  });

  const body = await request.json().catch(() => ({}));
  const forceRefresh = body.force === true;

  if (
    !forceRefresh &&
    dbUser?.insightsCachedAt &&
    dbUser.insightsCachedText &&
    Date.now() - dbUser.insightsCachedAt.getTime() < 24 * 60 * 60 * 1000
  ) {
    try {
      const cached = JSON.parse(dbUser.insightsCachedText) as InsightResult;
      annotate({ action: { name: "insights.generate" }, meta: { cached: true } });
      return apiSuccess({ insights: cached, cached: true, cachedAt: dbUser.insightsCachedAt });
    } catch {
      // Invalid cache, regenerate
    }
  }

  const provider = await resolveProvider(userId);

  if (provider.type === "none") {
    return apiError("No AI provider configured. Connect ChatGPT or ask your admin to set up an API key.", 422);
  }

  const includeRaw = dbUser?.insightsPrivacyMode === "raw";
  const features = await extractFeatures(userId, includeRaw);
  const { systemPrompt, userPrompt } = buildGeneratePrompts(
    JSON.stringify(features, null, 2),
    dbUser?.insightsPrivacyMode ?? "aggregated",
  );

  const result = await provider.generateCompletion({
    systemPrompt,
    userPrompt,
    temperature: 0.3,
    maxTokens: 1500,
  });

  let insights: InsightResult;
  try {
    const parsed = JSON.parse(result.content);
    insights = insightResultSchema.parse(parsed);
  } catch {
    return apiError("Failed to parse AI response", 502);
  }

  await prisma.user.update({
    where: { id: userId },
    data: {
      insightsCachedAt: new Date(),
      insightsCachedText: JSON.stringify(insights),
    },
  });

  await auditLog("insights.generate", {
    userId,
    ipAddress: getClientIp(request),
    details: {
      privacyMode: dbUser?.insightsPrivacyMode,
      tokensUsed: result.tokensUsed,
      providerType: result.providerType,
      model: result.model,
    },
  });

  annotate({
    action: { name: "insights.generate" },
    meta: {
      cached: false,
      providerType: result.providerType,
      model: result.model,
      tokensUsed: result.tokensUsed,
    },
  });

  return apiSuccess({ insights, cached: false });
});
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/insights/generate/route.ts
git commit -m "refactor(insights): use provider abstraction in generate route"
```

---

## Phase 4: Medical Prompts

### Task 13: Create prompt files

**Files:**
- Create: `src/lib/ai/prompts/base-system.ts`
- Create: `src/lib/ai/prompts/general-status.ts`
- Create: `src/lib/ai/prompts/blood-pressure.ts`
- Create: `src/lib/ai/prompts/weight.ts`
- Create: `src/lib/ai/prompts/pulse.ts`
- Create: `src/lib/ai/prompts/bmi.ts`
- Create: `src/lib/ai/prompts/medication-compliance.ts`
- Create: `src/lib/ai/prompts/schema.ts`

This task creates all prompt files. Each follows a consistent pattern with the base system prompt + domain-specific instructions + the new InsightResult JSON schema.

Detailed prompt content will be generated during implementation based on the spec's medical guidelines (ESC/ESH 2023, WHO BMI, DGE). The prompts instruct the model to return the `InsightResult` JSON schema and include leitlinien references.

- [ ] **Step 1: Create base-system.ts with shared medical context**

- [ ] **Step 2: Create all 6 domain-specific prompt files**

- [ ] **Step 3: Create schema.ts with the JSON schema description for the model**

- [ ] **Step 4: Write tests that verify prompt assembly**

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/prompts/
git commit -m "feat(prompts): add medical insight prompts with ESC/ESH/WHO guidelines"
```

---

## Phase 5: Update Individual Insight Generators

### Task 14: Refactor insight generators to use provider

Each of the 6 insight generators (`general-status.ts`, `blood-pressure-status.ts`, `weight-status.ts`, `pulse-status.ts`, `bmi-status.ts`, `medication-compliance-status.ts`) follows the same pattern. Refactor each to:

1. Replace `decrypt(user.openaiKeyEncrypted)` with `resolveProvider(userId)`
2. Replace direct `fetch("https://api.openai.com/...")` with `provider.generateCompletion()`
3. Use new domain-specific prompts from `src/lib/ai/prompts/`
4. Return `InsightResult` structure instead of `{ summary: string }`

- [ ] **Step 1: Refactor general-status.ts**
- [ ] **Step 2: Refactor blood-pressure-status.ts**
- [ ] **Step 3: Refactor weight-status.ts**
- [ ] **Step 4: Refactor pulse-status.ts**
- [ ] **Step 5: Refactor bmi-status.ts**
- [ ] **Step 6: Refactor medication-compliance-status.ts**
- [ ] **Step 7: Update reminder-worker.ts to pass through correctly**
- [ ] **Step 8: Run full test suite**

```bash
pnpm test
```

- [ ] **Step 9: Commit**

```bash
git add src/lib/insights/ src/lib/jobs/
git commit -m "refactor(insights): use provider abstraction in all 6 insight generators"
```

---

## Phase 6: Remove Legacy Code

### Task 15: Clean up old OpenAI references

- [ ] **Step 1: Remove `src/lib/insights/prompt.ts` (replaced by `src/lib/ai/prompts/`)**

- [ ] **Step 2: Update `src/app/api/insights/comprehensive/route.ts`** — change `hasOpenAiKey` to check provider availability

- [ ] **Step 3: Update CSP in `src/proxy.ts`** — add `https://chatgpt.com` to `connect-src`

- [ ] **Step 4: Search for any remaining `openaiKeyEncrypted` references**

```bash
grep -r "openaiKeyEncrypted\|openai_key_encrypted" src/ --include="*.ts"
```

Fix any found.

- [ ] **Step 5: Run typecheck**

```bash
pnpm typecheck
```

- [ ] **Step 6: Run all tests**

```bash
pnpm test
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: remove legacy OpenAI key references, update CSP"
```

---

## Phase 7: Build, Deploy, Verify

### Task 16: Build and deploy

- [ ] **Step 1: Run full build**

```bash
pnpm build
```

- [ ] **Step 2: Push to GitHub (triggers auto-deploy via webhook)**

```bash
git push origin main
```

- [ ] **Step 3: Monitor deployment**

Check Coolify deployment status for HealthLog on apps-01.

- [ ] **Step 4: Run database migration on production**

The migration should run automatically via the Dockerfile entrypoint. Verify in logs.

- [ ] **Step 5: Verify app is running**

```bash
curl -s https://healthlog.bombeck.io/api/health
```

---

### Task 17: Security Audit

- [ ] **Step 1: Pre-deploy code review** — Check all new files for:
  - Token leaks (tokens never sent to client)
  - Proper encryption (AES-256-GCM for all secrets)
  - CSRF protection (state parameter validation)
  - Input validation (Zod schemas)
  - Rate limiting on new endpoints

- [ ] **Step 2: OAuth flow audit** — Validate against OWASP OAuth 2.0 Security Checklist

- [ ] **Step 3: Penetration test** — Test OAuth callback with:
  - Invalid state parameter
  - Replayed authorization codes
  - Missing PKCE verifier
  - Token injection attempts

---

### Task 18: Post-deploy verification

- [ ] **Step 1: Test OAuth flow** — Navigate to settings, click "Mit ChatGPT verbinden", complete flow
- [ ] **Step 2: Test insight generation** — Trigger manual insight generation
- [ ] **Step 3: Test admin key** — Set admin key in settings, verify fallback works
- [ ] **Step 4: Test background jobs** — Check pg-boss logs for insight job execution
- [ ] **Step 5: Verify Loki logs** — No errors from new code paths
