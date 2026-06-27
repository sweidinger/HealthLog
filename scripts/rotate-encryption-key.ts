/**
 * scripts/rotate-encryption-key.ts <new-key-id>
 *
 * Re-encrypts every encrypted column in the database with the currently
 * active key (`ENCRYPTION_ACTIVE_KEY_ID`). Idempotent: rows whose ciphertext
 * already carries the active key id prefix are skipped.
 *
 * The set of columns this script rotates is the canonical registry in
 * `src/lib/crypto/encrypted-columns.ts`. The guard test
 * `src/lib/crypto/__tests__/encrypted-columns.test.ts` fails CI if any
 * encrypted column in `prisma/schema.prisma` is missing from the registry,
 * or if any registry column is not referenced here — so a new `*Encrypted`
 * column can never silently skip rotation (which would make those rows
 * permanently undecryptable once the legacy key is dropped, since decrypt is
 * fail-closed).
 *
 * Usage:
 *   ENCRYPTION_KEYS='{"v1":"<old>","v2":"<new>"}' \
 *   ENCRYPTION_ACTIVE_KEY_ID=v2 \
 *   pnpm tsx scripts/rotate-encryption-key.ts v2
 */
import "dotenv/config";
import { Buffer } from "node:buffer";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { decrypt, encrypt, extractKeyId, getActiveKeyId } from "@/lib/crypto";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL must be set");
  process.exit(1);
}

const targetKeyId = process.argv[2] ?? getActiveKeyId();
if (targetKeyId !== getActiveKeyId()) {
  console.error(
    `Refusing to rotate: argv key id '${targetKeyId}' does not match the ` +
      `currently active id '${getActiveKeyId()}'. Set ENCRYPTION_ACTIVE_KEY_ID first.`,
  );
  process.exit(2);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: DATABASE_URL }),
});

interface RotationResult {
  table: string;
  field: string;
  scanned: number;
  rotated: number;
  errors: number;
}

function shouldRotate(value: string | null): boolean {
  if (!value) return false;
  const id = extractKeyId(value);
  // null = legacy/unversioned (rotate); else rotate if not already on active.
  return id !== getActiveKeyId();
}

/**
 * Rotate one `String` ciphertext column on a Prisma model. `delegate` is the
 * `prisma.<model>` accessor; `field` is the column. Reads only `id` + the
 * column, re-encrypts every row not already on the active key.
 */
async function rotateStringColumn(
  table: string,
  field: string,
  delegate: {
    findMany: (args: {
      select: Record<string, true>;
    }) => Promise<Array<Record<string, unknown>>>;
    update: (args: {
      where: { id: string };
      data: Record<string, string>;
    }) => Promise<unknown>;
  },
): Promise<RotationResult> {
  const rows = await delegate.findMany({ select: { id: true, [field]: true } });
  const result: RotationResult = {
    table,
    field,
    scanned: rows.length,
    rotated: 0,
    errors: 0,
  };
  for (const row of rows) {
    const v = row[field] as string | null;
    if (!shouldRotate(v)) continue;
    const id = row.id as string;
    try {
      const re = encrypt(decrypt(v as string));
      await delegate.update({ where: { id }, data: { [field]: re } });
      result.rotated++;
    } catch (err) {
      result.errors++;
      console.error(`[${table}.${field}] row ${id}: ${(err as Error).message}`);
    }
  }
  return result;
}

/**
 * Rotate one `Bytes` ciphertext column. The encrypt/decrypt helpers operate
 * on strings, so we go through a UTF-8 Buffer round-trip identical to the
 * persistence layer (`src/lib/ai/coach/persistence.ts:60-71`).
 */
async function rotateBytesColumn(
  table: string,
  field: string,
  delegate: {
    findMany: (args: {
      select: Record<string, true>;
    }) => Promise<Array<Record<string, unknown>>>;
    update: (args: {
      where: { id: string };
      data: Record<string, Uint8Array>;
    }) => Promise<unknown>;
  },
): Promise<RotationResult> {
  const rows = await delegate.findMany({ select: { id: true, [field]: true } });
  const result: RotationResult = {
    table,
    field,
    scanned: rows.length,
    rotated: 0,
    errors: 0,
  };
  for (const row of rows) {
    const buf = row[field] as Uint8Array | null;
    if (!buf || buf.byteLength === 0) continue;
    const asString = Buffer.from(buf).toString("utf8");
    if (!shouldRotate(asString)) continue;
    const id = row.id as string;
    try {
      const rotated = encrypt(decrypt(asString));
      const encoded = Buffer.from(rotated, "utf8");
      const next = new Uint8Array(new ArrayBuffer(encoded.byteLength));
      next.set(encoded);
      await delegate.update({ where: { id }, data: { [field]: next } });
      result.rotated++;
    } catch (err) {
      result.errors++;
      console.error(`[${table}.${field}] row ${id}: ${(err as Error).message}`);
    }
  }
  return result;
}

async function main() {
  console.log(`Rotating encrypted rows to active key id: ${targetKeyId}`);
  const results: RotationResult[] = [];

  // ───── User — integration credentials + AI keys + KVNR (String) ─────
  // Columns: "codexAccessTokenEncrypted" "codexRefreshTokenEncrypted"
  // "telegramBotToken" "moodLogWebhookSecret" "moodLogUrlEncrypted"
  // "moodLogApiKeyEncrypted" "withingsClientIdEncrypted"
  // "withingsClientSecretEncrypted" "whoopClientIdEncrypted"
  // "whoopClientSecretEncrypted" "fitbitClientIdEncrypted"
  // "fitbitClientSecretEncrypted" "nightscoutUrlEncrypted"
  // "nightscoutTokenEncrypted" "polarAccessTokenEncrypted"
  // "polarUserIdEncrypted" "polarClientIdEncrypted"
  // "polarClientSecretEncrypted" "ouraAccessTokenEncrypted"
  // "ouraRefreshTokenEncrypted" "ouraClientIdEncrypted"
  // "ouraClientSecretEncrypted" "aiAnthropicKeyEncrypted"
  // "aiLocalKeyEncrypted" "aiOpenaiKeyEncrypted" "insuranceNumberEncrypted"
  const userFields = [
    "codexAccessTokenEncrypted",
    "codexRefreshTokenEncrypted",
    "telegramBotToken",
    "moodLogWebhookSecret",
    "moodLogUrlEncrypted",
    "moodLogApiKeyEncrypted",
    "withingsClientIdEncrypted",
    "withingsClientSecretEncrypted",
    "whoopClientIdEncrypted",
    "whoopClientSecretEncrypted",
    "fitbitClientIdEncrypted",
    "fitbitClientSecretEncrypted",
    "nightscoutUrlEncrypted",
    "nightscoutTokenEncrypted",
    "polarAccessTokenEncrypted",
    "polarUserIdEncrypted",
    "polarClientIdEncrypted",
    "polarClientSecretEncrypted",
    "ouraAccessTokenEncrypted",
    "ouraRefreshTokenEncrypted",
    "ouraClientIdEncrypted",
    "ouraClientSecretEncrypted",
    "aiAnthropicKeyEncrypted",
    "aiLocalKeyEncrypted",
    "aiOpenaiKeyEncrypted",
    "aiOcrKeyEncrypted",
    "insuranceNumberEncrypted",
    // v1.23 — TOTP shared secret (second factor).
    "totpSecretEncrypted",
  ];
  for (const field of userFields) {
    results.push(await rotateStringColumn("User", field, prisma.user));
  }

  // ───── OAuth token tables (String "accessToken" / "refreshToken") ─────
  for (const field of ["accessToken", "refreshToken"]) {
    results.push(
      await rotateStringColumn(
        "WithingsConnection",
        field,
        prisma.withingsConnection,
      ),
    );
    results.push(
      await rotateStringColumn(
        "WhoopConnection",
        field,
        prisma.whoopConnection,
      ),
    );
    results.push(
      await rotateStringColumn(
        "FitbitConnection",
        field,
        prisma.fitbitConnection,
      ),
    );
  }

  // ───── AppSettings — operator credentials (String) ─────
  // Columns: "adminAiKeyEncrypted" "webPushVapidPrivateKeyEncrypted"
  // "githubIssueTokenEncrypted"
  for (const field of [
    "adminAiKeyEncrypted",
    "webPushVapidPrivateKeyEncrypted",
    "githubIssueTokenEncrypted",
  ]) {
    results.push(
      await rotateStringColumn("AppSettings", field, prisma.appSettings),
    );
  }

  // ───── Custom labels — mood + cycle (String "labelEncrypted") ─────
  // Catalogue rows carry NULL and are skipped by `shouldRotate`.
  results.push(
    await rotateStringColumn("MoodTag", "labelEncrypted", prisma.moodTag),
  );
  results.push(
    await rotateStringColumn(
      "MoodTagCategory",
      "labelEncrypted",
      prisma.moodTagCategory,
    ),
  );
  results.push(
    await rotateStringColumn(
      "CycleSymptom",
      "labelEncrypted",
      prisma.cycleSymptom,
    ),
  );

  // ───── NotificationChannel."config" (encrypted JSON) ─────
  // Channel config (Telegram chat id, ntfy topic, etc.). Skipping these on
  // rotation would leave channels permanently undecryptable once the
  // operator drops `v1` from the key map.
  results.push(
    await rotateStringColumn(
      "NotificationChannel",
      "config",
      prisma.notificationChannel,
    ),
  );

  // ───── PushSubscription."p256dh" / "auth" ─────
  // Web-push routing secrets — without these, the push endpoint is reachable
  // but the browser ignores the message (auth tag mismatch).
  for (const field of ["p256dh", "auth"]) {
    results.push(
      await rotateStringColumn(
        "PushSubscription",
        field,
        prisma.pushSubscription,
      ),
    );
  }

  // ───── IntegrationStatus."lastError" ─────
  // AES-256-GCM ciphertext of an upstream error payload. Drop the legacy key
  // while a row still lives here and the admin status view 500s.
  results.push(
    await rotateStringColumn(
      "IntegrationStatus",
      "lastError",
      prisma.integrationStatus,
    ),
  );

  // ───── CycleDayLog — "sensitiveEncrypted" / "notesEncrypted" (String) ─────
  for (const field of ["sensitiveEncrypted", "notesEncrypted"]) {
    results.push(
      await rotateStringColumn("CycleDayLog", field, prisma.cycleDayLog),
    );
  }

  // ───── Coach (Bytes columns) ─────
  // "encryptedContent" "summaryEncrypted" "factEncrypted"
  results.push(
    await rotateBytesColumn(
      "CoachMessage",
      "encryptedContent",
      prisma.coachMessage,
    ),
  );
  results.push(
    await rotateBytesColumn(
      "CoachConversation",
      "summaryEncrypted",
      prisma.coachConversation,
    ),
  );
  results.push(
    await rotateBytesColumn("CoachFact", "factEncrypted", prisma.coachFact),
  );

  // ───── CoachPlan (Bytes columns) ─────
  // "ifCueEncrypted" "thenActionEncrypted" "targetEncrypted" "outcomeEncrypted"
  for (const field of [
    "ifCueEncrypted",
    "thenActionEncrypted",
    "targetEncrypted",
    "outcomeEncrypted",
  ]) {
    results.push(await rotateBytesColumn("CoachPlan", field, prisma.coachPlan));
  }

  // ───── CoachReminder (Bytes column) ─────
  // "noteEncrypted"
  results.push(
    await rotateBytesColumn(
      "CoachReminder",
      "noteEncrypted",
      prisma.coachReminder,
    ),
  );

  // ───── UserHealthProfile (Bytes columns) ─────
  // "aboutMeEncrypted" "conditionsEncrypted" "allergiesEncrypted"
  // "coachFocusEncrypted" "pendingQuestionsEncrypted"
  for (const field of [
    "aboutMeEncrypted",
    "conditionsEncrypted",
    "allergiesEncrypted",
    "coachFocusEncrypted",
    "pendingQuestionsEncrypted",
  ]) {
    results.push(
      await rotateBytesColumn(
        "UserHealthProfile",
        field,
        prisma.userHealthProfile,
      ),
    );
  }

  // ───── InsightNarrative."encryptedContent" (Bytes) ─────
  results.push(
    await rotateBytesColumn(
      "InsightNarrative",
      "encryptedContent",
      prisma.insightNarrative,
    ),
  );

  // ───── v1.18.1 clinical-spine notes (Bytes columns) ─────
  // "noteEncrypted" (LabResult / IllnessEpisode / IllnessDayLog) +
  // "contextEncrypted" (Biomarker). Mirror the CoachFact.factEncrypted block.
  results.push(
    await rotateBytesColumn("LabResult", "noteEncrypted", prisma.labResult),
  );
  results.push(
    await rotateBytesColumn("Biomarker", "contextEncrypted", prisma.biomarker),
  );
  results.push(
    await rotateBytesColumn(
      "IllnessEpisode",
      "noteEncrypted",
      prisma.illnessEpisode,
    ),
  );
  results.push(
    await rotateBytesColumn(
      "IllnessDayLog",
      "noteEncrypted",
      prisma.illnessDayLog,
    ),
  );

  // ───── v1.19.0 ECG waveform (Bytes column) ─────
  // "waveformEncrypted" holds the JSON-encoded micro-volt sample array in the
  // same `encrypt()` ciphertext-string-as-UTF-8 shape the Coach columns use
  // (see src/lib/withings/ecg-waveform-codec.ts), so the generic Bytes
  // rotation re-stamps it without decoding the waveform.
  results.push(
    await rotateBytesColumn(
      "EcgRecording",
      "waveformEncrypted",
      prisma.ecgRecording,
    ),
  );

  // ───── v1.23 free-text health notes (Bytes columns) ─────
  // "noteEncrypted" (MoodEntry) + "notesEncrypted" (Measurement). Same shared-
  // codec shape as the clinical-spine note columns. NULL on rows whose note is
  // still in the legacy plaintext column (pre-backfill) — `rotateBytesColumn`
  // skips those.
  results.push(
    await rotateBytesColumn("MoodEntry", "noteEncrypted", prisma.moodEntry),
  );
  results.push(
    await rotateBytesColumn(
      "Measurement",
      "notesEncrypted",
      prisma.measurement,
    ),
  );

  console.log("\n=== Rotation summary ===");
  let totalRotated = 0;
  let totalErrors = 0;
  for (const r of results) {
    console.log(
      `${r.table}.${r.field}: scanned=${r.scanned} rotated=${r.rotated} errors=${r.errors}`,
    );
    totalRotated += r.rotated;
    totalErrors += r.errors;
  }
  console.log(`\nTOTAL rotated=${totalRotated} errors=${totalErrors}`);
  await prisma.$disconnect();
  process.exit(totalErrors > 0 ? 3 : 0);
}

main().catch(async (err) => {
  console.error("Rotation failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
