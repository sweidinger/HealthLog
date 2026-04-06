# Changelog

## [1.1.0] — 2026-04-06

### Added — AI Insights Overhaul

- **ChatGPT Proxy Integration**: Insights now run through a local openai-oauth proxy using your ChatGPT subscription — no separate API billing required
- **Admin AI Fallback**: Admins can configure a global API key (OpenAI/OpenRouter) as fallback for users without their own connection
- **Provider Abstraction**: New `src/lib/ai/` module with pluggable providers (Codex OAuth, Admin Key, None) and automatic failover
- **Medical Insight Prompts**: 7 specialized prompts based on ESC/ESH 2023, WHO, DGE, and DEGAM guidelines
  - Blood Pressure: ESC/ESH classification, morning risk ladder (J-HOP), pulse pressure, seasonal variation
  - Weight: 5%/10% milestone recognition, plateau detection, body composition divergence
  - Pulse: Fitness interpretation ladder, 80-100 bpm elevated-risk band, rate-pressure product
  - BMI: Age-adjusted DEGAM classification for 65+
  - Medication Compliance: Chronotherapy hints, mood-adherence risk prediction, 90-day tracking
  - General Status: Cross-domain synthesis with cardiovascular risk stratification
  - Mood: Bidirectional correlations with vitals and adherence
- **Enriched Feature Extraction**:
  - Sleep duration and activity steps (previously ignored)
  - Rate-Pressure Product (pulse × systolic BP, myocardial demand indicator)
  - Body composition divergence flag (weight stable + body fat rising)
  - Mood-adherence risk predictor
  - Seasonal BP variation (winter vs summer, requires >180 days data)
  - BP standard deviation (sdSys30/sdDia30) as variability risk marker
  - Pulse pressure (arterial stiffness marker)
  - 5 cross-metric Pearson correlations (weight↔BP, pulse↔BP, mood↔pulse, mood↔BP, mood↔weight)
  - 90-day averages and all-time statistics for all metrics
  - Historical comparison (current 7d vs previous 30d baseline)
- **New UI Components**:
  - `InsightStatusCard`: Compact per-metric status card with classification indicator and fade-in animation
  - `InsightAdvisorCard`: Premium structured card with findings, correlations, recommendations (ready for integration)
- **OAuth Routes**: `/api/auth/codex/authorize`, `/callback`, `/disconnect` for ChatGPT connection
- **Admin AI Settings**: `/api/admin/ai-settings` for global API key management

### Changed

- Insight prompts now use personal advisor tone ("dein Blutdruck") with positive-first pattern
- Reasoning scaffold in system prompt (What changed? → Why? → What to do?)
- Conditional correlation instructions (only mention when |r| > 0.4)
- InsightResult schema enriched with `insightType`, `primaryRecommendation`, `classificationLabel`
- BP target calculation now uses paired readings (both sys AND dia must be in range simultaneously)
- Medication streak tracking extended from 7-day to 30-day window
- CSP updated to allow `chatgpt.com` for OAuth flow

### Security

- Rate limiting on all OAuth and admin endpoints
- PKCE (S256) + state parameter for OAuth CSRF protection
- Encrypted token storage at rest (AES-256-GCM)
- Error messages truncated to prevent upstream response body leaks
- Admin key preview shows last 4 chars of decrypted key (not ciphertext prefix)
- `prefers-reduced-motion` support for insight card animations

### Removed

- `openaiKeyEncrypted` field from User model (replaced by provider abstraction)
- Direct OpenAI API calls from insight generators (now routed through provider)
- Legacy API key input in settings UI (replaced by ChatGPT connect button)

## [1.0.1] — Previous release
