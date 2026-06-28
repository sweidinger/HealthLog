/**
 * Canonical registry of every database column that holds AES-256-GCM
 * ciphertext (via `src/lib/crypto.ts`).
 *
 * This is the single source of truth for the key-rotation script
 * (`scripts/rotate-encryption-key.ts`): the script MUST re-encrypt every
 * column listed here, and the guard test
 * (`encrypted-columns.test.ts`) asserts three invariants:
 *
 *   1. Every encrypted column in `prisma/schema.prisma` (any `*Encrypted`
 *      column, plus the small set of historically-named encrypted columns
 *      enumerated below) appears in this registry.
 *   2. The rotation script references every column in this registry.
 *   3. No registry entry is missing a kind / duplicated.
 *
 * Adding a new encrypted column WITHOUT adding it here fails CI; adding it
 * here without wiring the rotation script also fails CI. Together this makes
 * "a new encrypted column silently skipped on rotation" structurally
 * impossible — dropping a legacy key would otherwise make those rows
 * permanently undecryptable (decrypt is fail-closed).
 *
 * `kind` distinguishes the storage shape the rotation script must use:
 *   - "string" — the ciphertext is stored as a `String` column; the script
 *     reads/writes the value directly.
 *   - "bytes"  — the ciphertext is stored as a `Bytes` column; the script
 *     goes through a UTF-8 Buffer round-trip (matching the persistence layer).
 */

export type EncryptedColumnKind = "string" | "bytes";

export interface EncryptedColumn {
  /** Prisma model name (PascalCase, as declared in schema.prisma). */
  readonly model: string;
  /** Prisma field name (camelCase, as declared in schema.prisma). */
  readonly field: string;
  readonly kind: EncryptedColumnKind;
}

/**
 * Every reversibly-encrypted column. HMAC-hashed columns (`*Hash`,
 * `tokenHash`) and the `refresh_token`-convention columns are deliberately
 * EXCLUDED — they are one-way and have no rotation path.
 */
export const ENCRYPTED_COLUMNS: readonly EncryptedColumn[] = [
  // ───── User — integration credentials + AI keys + KVNR ─────
  { model: "User", field: "codexAccessTokenEncrypted", kind: "string" },
  { model: "User", field: "codexRefreshTokenEncrypted", kind: "string" },
  { model: "User", field: "telegramBotToken", kind: "string" },
  { model: "User", field: "moodLogWebhookSecret", kind: "string" },
  { model: "User", field: "moodLogUrlEncrypted", kind: "string" },
  { model: "User", field: "moodLogApiKeyEncrypted", kind: "string" },
  { model: "User", field: "withingsClientIdEncrypted", kind: "string" },
  { model: "User", field: "withingsClientSecretEncrypted", kind: "string" },
  { model: "User", field: "whoopClientIdEncrypted", kind: "string" },
  { model: "User", field: "whoopClientSecretEncrypted", kind: "string" },
  { model: "User", field: "fitbitClientIdEncrypted", kind: "string" },
  { model: "User", field: "fitbitClientSecretEncrypted", kind: "string" },
  { model: "User", field: "nightscoutUrlEncrypted", kind: "string" },
  { model: "User", field: "nightscoutTokenEncrypted", kind: "string" },
  { model: "User", field: "polarAccessTokenEncrypted", kind: "string" },
  { model: "User", field: "polarUserIdEncrypted", kind: "string" },
  { model: "User", field: "polarClientIdEncrypted", kind: "string" },
  { model: "User", field: "polarClientSecretEncrypted", kind: "string" },
  { model: "User", field: "ouraAccessTokenEncrypted", kind: "string" },
  { model: "User", field: "ouraRefreshTokenEncrypted", kind: "string" },
  { model: "User", field: "ouraClientIdEncrypted", kind: "string" },
  { model: "User", field: "ouraClientSecretEncrypted", kind: "string" },
  { model: "User", field: "aiAnthropicKeyEncrypted", kind: "string" },
  { model: "User", field: "aiLocalKeyEncrypted", kind: "string" },
  { model: "User", field: "aiOpenaiKeyEncrypted", kind: "string" },
  // v1.22 (#90) — dedicated document-scan (Lab-OCR) provider key.
  { model: "User", field: "aiOcrKeyEncrypted", kind: "string" },
  { model: "User", field: "insuranceNumberEncrypted", kind: "string" },
  // v1.23 — TOTP shared secret (second factor). String ciphertext like the
  // other User credential columns.
  { model: "User", field: "totpSecretEncrypted", kind: "string" },

  // ───── OAuth token tables (`*_token`-convention columns) ─────
  { model: "WithingsConnection", field: "accessToken", kind: "string" },
  { model: "WithingsConnection", field: "refreshToken", kind: "string" },
  { model: "WhoopConnection", field: "accessToken", kind: "string" },
  { model: "WhoopConnection", field: "refreshToken", kind: "string" },
  { model: "FitbitConnection", field: "accessToken", kind: "string" },
  { model: "FitbitConnection", field: "refreshToken", kind: "string" },

  // ───── AppSettings — operator credentials ─────
  { model: "AppSettings", field: "adminAiKeyEncrypted", kind: "string" },
  {
    model: "AppSettings",
    field: "webPushVapidPrivateKeyEncrypted",
    kind: "string",
  },

  // ───── Custom labels (mood + cycle) ─────
  { model: "MoodTag", field: "labelEncrypted", kind: "string" },
  { model: "MoodTagCategory", field: "labelEncrypted", kind: "string" },
  { model: "CycleSymptom", field: "labelEncrypted", kind: "string" },

  // ───── Notification + push secrets ─────
  { model: "NotificationChannel", field: "config", kind: "string" },
  { model: "PushSubscription", field: "p256dh", kind: "string" },
  { model: "PushSubscription", field: "auth", kind: "string" },

  // ───── Integration status error payloads ─────
  { model: "IntegrationStatus", field: "lastError", kind: "string" },

  // ───── Cycle day-log sensitive payloads (String?) ─────
  { model: "CycleDayLog", field: "sensitiveEncrypted", kind: "string" },
  { model: "CycleDayLog", field: "notesEncrypted", kind: "string" },

  // ───── Coach (Bytes columns) ─────
  { model: "CoachMessage", field: "encryptedContent", kind: "bytes" },
  { model: "CoachConversation", field: "summaryEncrypted", kind: "bytes" },
  { model: "CoachFact", field: "factEncrypted", kind: "bytes" },
  // v1.21.3 (B1) — Coach goal / if-then plan free-text columns.
  { model: "CoachPlan", field: "ifCueEncrypted", kind: "bytes" },
  { model: "CoachPlan", field: "thenActionEncrypted", kind: "bytes" },
  { model: "CoachPlan", field: "targetEncrypted", kind: "bytes" },
  // v1.22 (W9, C2) — n-of-1 experiment outcome read-back prose.
  { model: "CoachPlan", field: "outcomeEncrypted", kind: "bytes" },
  // v1.22 (B2/B6) — Coach episodic reminder free-text note.
  { model: "CoachReminder", field: "noteEncrypted", kind: "bytes" },

  // ───── User health profile (Bytes columns) ─────
  { model: "UserHealthProfile", field: "aboutMeEncrypted", kind: "bytes" },
  { model: "UserHealthProfile", field: "conditionsEncrypted", kind: "bytes" },
  { model: "UserHealthProfile", field: "allergiesEncrypted", kind: "bytes" },
  { model: "UserHealthProfile", field: "coachFocusEncrypted", kind: "bytes" },
  {
    model: "UserHealthProfile",
    field: "pendingQuestionsEncrypted",
    kind: "bytes",
  },

  // ───── Insight narratives (Bytes column) ─────
  { model: "InsightNarrative", field: "encryptedContent", kind: "bytes" },

  // ───── v1.18.1 clinical-spine notes (Bytes columns) ─────
  { model: "LabResult", field: "noteEncrypted", kind: "bytes" },
  { model: "Biomarker", field: "contextEncrypted", kind: "bytes" },
  { model: "IllnessEpisode", field: "noteEncrypted", kind: "bytes" },
  { model: "IllnessDayLog", field: "noteEncrypted", kind: "bytes" },

  // ───── v1.19.0 ECG waveform (Bytes column) ─────
  { model: "EcgRecording", field: "waveformEncrypted", kind: "bytes" },

  // ───── v1.23 free-text health notes (Bytes columns) ─────
  // Free-text mood diary + per-measurement notes. Same class as the
  // IllnessDayLog / LabResult note columns above; Bytes via the shared codec.
  { model: "MoodEntry", field: "noteEncrypted", kind: "bytes" },
  { model: "Measurement", field: "notesEncrypted", kind: "bytes" },

  // ───── v1.25 medication free-text notes (Bytes columns) ─────
  // Side-effect log note, dose-change titration note, and inventory-item
  // note — the last plaintext PHI columns left after the v1.23 rollout.
  { model: "MedicationSideEffect", field: "notesEncrypted", kind: "bytes" },
  { model: "MedicationDoseChange", field: "noteEncrypted", kind: "bytes" },
  { model: "MedicationInventoryItem", field: "notesEncrypted", kind: "bytes" },

  // ───── v1.25 mental-health screener item answers (Bytes column) ─────
  // The PHQ-9 / GAD-7 per-item responses (incl. the safety-critical item 9)
  // ride a single AES-256-GCM blob. The most sensitive payload in the wave;
  // never indexed, never logged, never in wide-event meta.
  {
    model: "MentalHealthAssessment",
    field: "responsesEncrypted",
    kind: "bytes",
  },
  // ───── v1.25 structured health records (Bytes columns) ─────
  // Allergy free-text reaction + note, and the family-history note. The
  // structured enum/label columns stay queryable plaintext; only the
  // sensitive free-text fields are encrypted.
  { model: "Allergy", field: "reactionEncrypted", kind: "bytes" },
  { model: "Allergy", field: "notesEncrypted", kind: "bytes" },
  { model: "FamilyHistoryEntry", field: "notesEncrypted", kind: "bytes" },

  // ───── v1.25 (W-DOCS-IN) inbound clinical document (Bytes column) ─────
  // The raw uploaded doctor report / discharge letter, base64-of-binary →
  // AES-256-GCM string → UTF-8 bytes. The most sensitive blob in the wave
  // (a full clinical document); never logged, never in wide-event meta.
  { model: "InboundDocument", field: "contentEncrypted", kind: "bytes" },
] as const;

/** Stable `Model.field` key for a registry entry. */
export function encryptedColumnKey(c: EncryptedColumn): string {
  return `${c.model}.${c.field}`;
}
