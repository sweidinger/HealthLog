# Codex OAuth + Medizinische Insights — Design Spec

**Datum:** 2026-04-06
**Status:** Approved
**Scope:** Replace OpenAI API-Key flow with ChatGPT Codex OAuth, improve medical insight prompts

## 1. Problem

HealthLog uses user-provided OpenAI API keys for AI-powered health insights. The API quota ran out (`insufficient_quota`), breaking all insight generation and background jobs. Users shouldn't need to manage API billing.

## 2. Solution

Replace the API-key model with **OpenAI Codex OAuth** — users authenticate with their ChatGPT Pro/Max subscription, and insights run against their flat-rate plan. An admin-level API key serves as a global fallback.

## 3. Provider Hierarchy

```
1. User has Codex OAuth connection → Codex Responses API (gpt-5.3-codex)
2. Admin key configured → Standard OpenAI Chat Completions API (configurable model)
3. Nothing configured → Local fallback texts (no-key-fallbacks.ts)
```

## 4. Architecture

### New Files

```
src/lib/ai/
  provider.ts          — resolveProvider(userId) → { type, client, model }
  codex-oauth.ts       — PKCE generation, token exchange, refresh
  codex-client.ts      — Codex Responses API client with auto-refresh
  openai-client.ts     — Standard OpenAI client (admin key, configurable base URL)
  types.ts             — Shared types (InsightResult, ProviderConfig, etc.)
  prompts/
    base-system.ts     — Shared medical context, role, constraints
    general-status.ts  — Holistic health assessment prompt
    blood-pressure.ts  — ESC/ESH guideline-based BP analysis
    weight.ts          — BMI context, trend analysis, plateau detection
    pulse.ts           — Resting HR trends, stress correlation
    bmi.ts             — WHO classification, age-adjusted
    medication-compliance.ts — Intake patterns, efficacy correlation
    schema.ts          — Zod schema for InsightResult validation
```

### Modified Files

```
src/app/api/auth/codex/authorize/route.ts    — NEW: Start OAuth flow
src/app/api/auth/codex/callback/route.ts     — NEW: Handle OAuth callback
src/app/api/auth/codex/disconnect/route.ts   — NEW: Remove tokens
src/app/api/admin/ai-settings/route.ts       — NEW: Admin key management
src/app/api/insights/generate/route.ts       — MODIFY: Use provider abstraction
src/app/api/insights/settings/route.ts       — MODIFY: Show Codex status instead of API key
src/app/api/insights/*/route.ts              — MODIFY: New output schema
src/lib/insights/*.ts                        — MODIFY: Use new prompts + provider
src/lib/jobs/reminder-worker.ts              — MODIFY: Use provider with auto-refresh
src/proxy.ts                                 — MODIFY: Add /api/auth/codex/callback to PUBLIC_PATHS
prisma/schema.prisma                         — MODIFY: New fields, remove openaiKeyEncrypted
```

### Removed Files/Code

```
src/app/api/insights/settings/route.ts       — OpenAI key PUT handler (replaced)
src/lib/insights/prompt.ts                   — Single prompt file (replaced by prompts/)
User.openaiKeyEncrypted                      — DB field removed
```

## 5. OAuth Flow

### Authorization (User-initiated)

```
1. User clicks "Mit ChatGPT verbinden" in Settings
2. GET /api/auth/codex/authorize
   - Generate PKCE code_verifier (128 bytes, base64url)
   - Compute code_challenge = SHA-256(code_verifier), base64url
   - Generate random state parameter
   - Store code_verifier + state in session
   - Redirect to: chatgpt.com/authorize?
       response_type=code
       &code_challenge=<challenge>
       &code_challenge_method=S256
       &redirect_uri=https://healthlog.bombeck.io/api/auth/codex/callback
       &state=<state>
3. User logs in at ChatGPT, grants access
4. Redirect to /api/auth/codex/callback?code=...&state=...
5. Validate state against session
6. Exchange code for tokens (POST chatgpt.com/oauth/token)
7. Encrypt access_token + refresh_token with AES-256-GCM
8. Store in User record with expiresAt
9. Redirect to /settings with success toast
```

### Token Refresh (Automatic)

```
Before every API call:
  if codexTokenExpiresAt < now + 5min:
    POST chatgpt.com/oauth/token (grant_type=refresh_token)
    Store new encrypted tokens + new expiresAt
    If refresh fails:
      Increment failCount
      If failCount >= 3 over 72h:
        Set codexConnectionStatus = 'expired'
        Fall back to admin key silently
      Else:
        Retry on next call

On 401 response:
  Refresh token immediately, retry request once
```

### Disconnect

```
DELETE /api/auth/codex/disconnect
  - Delete tokens from DB
  - Revoke at OpenAI if endpoint exists
  - Audit log entry
```

## 6. Database Changes

### Prisma Schema

```prisma
model User {
  // REMOVE:
  // openaiKeyEncrypted    String?

  // ADD:
  codexAccessTokenEncrypted   String?
  codexRefreshTokenEncrypted  String?
  codexTokenExpiresAt         DateTime?
  codexConnectedAt            DateTime?
  codexConnectionStatus       String    @default("disconnected")
  // Values: "connected", "disconnected", "expired"
}

model AppSettings {
  // ADD:
  adminAiKeyEncrypted   String?
  adminAiModel          String   @default("gpt-4o-mini")
  adminAiBaseUrl        String   @default("https://api.openai.com/v1")
}
```

### Migration

```sql
-- Add new columns
ALTER TABLE users ADD COLUMN codex_access_token_encrypted TEXT;
ALTER TABLE users ADD COLUMN codex_refresh_token_encrypted TEXT;
ALTER TABLE users ADD COLUMN codex_token_expires_at TIMESTAMP;
ALTER TABLE users ADD COLUMN codex_connected_at TIMESTAMP;
ALTER TABLE users ADD COLUMN codex_connection_status TEXT NOT NULL DEFAULT 'disconnected';

ALTER TABLE app_settings ADD COLUMN admin_ai_key_encrypted TEXT;
ALTER TABLE app_settings ADD COLUMN admin_ai_model TEXT NOT NULL DEFAULT 'gpt-4o-mini';
ALTER TABLE app_settings ADD COLUMN admin_ai_base_url TEXT NOT NULL DEFAULT 'https://api.openai.com/v1';

-- Remove old column
ALTER TABLE users DROP COLUMN openai_key_encrypted;
```

## 7. Insight Output Schema

### New InsightResult (replaces old changed/stable/drivers/nextSteps)

```typescript
interface InsightResult {
  summary: string
  classification: 'optimal' | 'gut' | 'grenzwertig' | 'erhoht' | 'kritisch'
  findings: {
    label: string
    value: string
    assessment: 'positive' | 'neutral' | 'attention' | 'warning'
    guideline?: string
  }[]
  correlations: {
    factor: string
    effect: string
    confidence: 'hoch' | 'mittel' | 'gering'
  }[]
  recommendations: string[]
  dataQuality: {
    coverage: string
    gaps: string[]
    confidence: 'hoch' | 'mittel' | 'gering'
  }
  disclaimer: string
}
```

### Zod Validation

Every AI response is validated against a Zod schema before being stored.
Invalid responses are logged as errors and the user gets a generic fallback.

## 8. Prompt Design

### Base System Prompt

```
Du bist ein klinischer Gesundheitsanalyst mit Expertise in Innerer Medizin
und Präventivmedizin. Deine Analyse basiert auf aktuellen Leitlinien
(ESC/ESH 2023, WHO, DGE, DEGAM).

Regeln:
- Evidenzbasiert: Referenziere Grenzwerte und Leitlinien explizit
- Muster erkennen: Tageszeit, Wochentag, saisonale Trends
- Korrelationen: Wechselwirkungen zwischen Medikation und Vitalwerten benennen
- Limitationen: Klar kommunizieren was die Datenlage hergibt und was nicht
- Kein Ersatz für ärztliche Diagnose — immer explizit als Disclaimer
- Sprache: Deutsch, medizinisch präzise aber allgemeinverständlich
- Antworte ausschließlich im vorgegebenen JSON-Schema
```

### Per-Type Specialization

Each insight type adds domain-specific instructions:

- **Blood Pressure**: ESC/ESH classification (optimal <120/80, normal <130/85, ...), morning surge detection, white-coat vs. masked hypertension hints, medication correlation
- **Weight**: BMI-adjusted analysis, 7/30/90-day slope, plateau detection (±0.5kg over 14+ days), realistic goal projection
- **Pulse**: Resting HR zones (bradycardia <50, athletic 50-60, normal 60-100, tachycardia >100), trend stability, stress/recovery indicators
- **BMI**: WHO classification, waist-to-height hints if available, age context
- **Medication Compliance**: Pattern analysis (morning vs evening adherence), streak tracking, correlation with vital sign improvements
- **General Status**: Cross-domain synthesis, risk stratification, most impactful change recommendation

## 9. UI Changes

### User Settings (/settings)

Replace "OpenAI API Key" section with:

```
KI-Insights
┌─────────────────────────────────────────┐
│ Status: 🟢 Verbunden mit ChatGPT       │
│ Verbunden seit: 02.04.2026             │
│                                         │
│ [Trennen]                               │
│                                         │
│ ℹ️ Insights werden über dein ChatGPT-   │
│ Abo generiert (keine zusätzlichen       │
│ Kosten).                                │
└─────────────────────────────────────────┘
```

Or when disconnected:

```
KI-Insights
┌─────────────────────────────────────────┐
│ Status: ⚪ Nicht verbunden              │
│                                         │
│ [Mit ChatGPT verbinden]                 │
│                                         │
│ ℹ️ Verbinde dein ChatGPT Pro/Max-Konto  │
│ um KI-gestützte Gesundheitsanalysen zu  │
│ erhalten.                               │
└─────────────────────────────────────────┘
```

### Admin Settings (/settings — ADMIN only)

```
KI-Anbieter (Global)
┌─────────────────────────────────────────┐
│ API Key:  [sk-...****________] [Testen] │
│ Modell:   [gpt-4o-mini ▾]              │
│ Base URL: [https://api.openai.com/v1]   │
│                                         │
│ ℹ️ Wird als Fallback verwendet, wenn    │
│ ein User keine eigene ChatGPT-          │
│ Verbindung hat.                         │
│                                         │
│ [Speichern]                             │
└─────────────────────────────────────────┘
```

### Insights Display

Update insight cards to render the richer InsightResult:
- Classification badge with color (green/yellow/orange/red)
- Findings list with assessment icons
- Collapsible correlations section
- Data quality indicator (small badge)
- Disclaimer footer (smaller text)

## 10. Security

### OAuth Security
- PKCE (S256) prevents authorization code interception
- State parameter prevents CSRF
- Tokens encrypted at rest (AES-256-GCM via existing crypto.ts)
- Tokens never sent to client/browser
- Refresh token rotation on every refresh
- Callback route validates state against session

### Admin Key Security
- Only ADMIN role can read/write
- Key displayed masked in UI (sk-...****)
- Rate limiting on admin key usage (prevents abuse by many users)
- Encrypted at rest

### Audit Trail
- Every OAuth connect/disconnect logged
- Every insight generation logs: provider type, user, model, duration
- Admin key changes logged

### Security Audits (3x)
1. **Pre-Implementation**: OAuth flow validated against OWASP OAuth Security Checklist
2. **Post-Implementation**: Code review agent checks all new files for injection, token leaks, unencrypted secrets
3. **Post-Deploy**: Penetration test of OAuth endpoints (CSRF, token theft, callback manipulation)

## 11. Testing Strategy (TDD)

### Unit Tests (vitest)

| Suite | Coverage |
|-------|----------|
| `ai/provider.test.ts` | Provider hierarchy, correct client selection |
| `ai/codex-oauth.test.ts` | PKCE generation, token exchange, refresh, error scenarios |
| `ai/codex-client.test.ts` | Request format, auto-refresh on 401, retry with backoff |
| `ai/openai-client.test.ts` | Chat completions format, custom base URL, error handling |
| `ai/prompts/*.test.ts` | Prompt assembly per type, output schema validation with Zod |
| `insights/*.test.ts` | Updated generators with new output schema |
| `api/codex-callback.test.ts` | State validation, CSRF protection, token storage |
| `api/admin-settings.test.ts` | ADMIN-only access, key encryption, validation |

### Integration Tests
- OAuth flow end-to-end (mocked ChatGPT endpoint)
- Background job token refresh + insight generation
- Provider fallback chain under different DB states

## 12. CSP Changes

```diff
- connect-src 'self' https://api.openai.com https://wbsapi.withings.net
+ connect-src 'self' https://api.openai.com https://chatgpt.com https://wbsapi.withings.net
```

## 13. Migration Path

1. Deploy new code with both old (openaiKeyEncrypted) and new fields
2. Run migration to add new columns
3. Remove old column in follow-up migration
4. Users see "Nicht verbunden" in settings, can connect via OAuth
5. Admin can configure fallback key immediately
6. Old cached insights remain visible until refreshed

## 14. Out of Scope

- Multiple AI providers per user (only Codex OAuth OR admin key)
- Custom model selection per user (model is fixed per provider)
- Streaming responses (batch only, like current implementation)
- OpenAI API key input for individual users (removed entirely)
