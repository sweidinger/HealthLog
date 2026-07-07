/**
 * Document-vault e2e fixture — seeded straight through Postgres (`pg`, the
 * same transport `global-setup.ts` uses) because the doctor-flow script
 * needs 60 documents and the upload endpoint's per-user rate bucket is
 * 60/hour: seeding through the API would burn the whole budget before the
 * first genuine upload test runs, and the two Playwright projects (desktop
 * + mobile) each re-run the seed.
 *
 * The seed is deterministic and idempotent:
 *   - fixed row ids (`e2evault…`), upserted with `ON CONFLICT (id) DO
 *     UPDATE` so a re-run self-heals whatever a previous run mutated;
 *   - per-document unique plaintext (an id marker inside the bytes) so the
 *     `(user_id, content_sha256)` live-dedupe partial unique index never
 *     trips across rows;
 *   - blobs encrypted with the SAME binary2 layout the server writes
 *     (`[0x02][keyIdLen][keyId][iv 12][tag 16][ciphertext]`, AES-256-GCM
 *     under the env key), so the serve route decrypts and previews them
 *     like real uploads.
 *
 * Corpus (mirrors the plan's §1A doctor-flow seed): 60 documents across
 * 3 years, one IllnessEpisode "Knie", an MRI report (IMAGING, "MRT Knie",
 * last autumn, linked to Knie) plus two adjacent image documents on the
 * same date and link. `seedNamespaceDocs` adds disposable per-test
 * namespaces (bulk flows) that never collide with the doctor-flow corpus.
 */
import { createCipheriv, createHash, randomBytes } from "node:crypto";

import pg from "pg";

import { E2E_USER } from "./global-setup";

// ─── binary2 codec (mirrors src/lib/crypto.ts encryptBytes) ────────────────

function resolveActiveKey(): { id: string; key: Buffer } {
  const mapRaw = process.env.ENCRYPTION_KEYS;
  if (mapRaw) {
    const map = JSON.parse(mapRaw) as Record<string, string>;
    const id =
      process.env.ENCRYPTION_ACTIVE_KEY_ID ?? Object.keys(map)[0] ?? "v1";
    const hex = map[id];
    if (!hex) {
      throw new Error(`[vault-fixture] key id '${id}' not in ENCRYPTION_KEYS`);
    }
    return { id, key: Buffer.from(hex, "hex") };
  }
  const legacy = process.env.ENCRYPTION_KEY;
  if (!legacy) {
    throw new Error(
      "[vault-fixture] neither ENCRYPTION_KEYS nor ENCRYPTION_KEY is set",
    );
  }
  return { id: "v1", key: Buffer.from(legacy, "hex") };
}

function encryptBinary2(plaintext: Buffer): Buffer {
  const { id, key } = resolveActiveKey();
  const keyId = Buffer.from(id, "ascii");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([
    Buffer.from([0x02, keyId.byteLength]),
    keyId,
    iv,
    tag,
    ct,
  ]);
}

// ─── Deterministic tiny documents ───────────────────────────────────────────

/** Minimal single-page PDF; `marker` lands in a comment so every doc's bytes
 *  (and therefore sha256) are unique. */
function tinyPdf(marker: string): Buffer {
  return Buffer.from(
    `%PDF-1.4\n%${marker}\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n` +
      `2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n` +
      `3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n` +
      `xref\n0 4\ntrailer<</Size 4/Root 1 0 R>>\n%%EOF\n`,
    "utf8",
  );
}

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABXvMqOgAAAABJRU5ErkJggg==",
  "base64",
);

/** 1×1 PNG + a trailing marker (decoders ignore bytes past IEND). */
function tinyPng(marker: string): Buffer {
  return Buffer.concat([PNG_1X1, Buffer.from(marker, "utf8")]);
}

// ─── Fixture identity ───────────────────────────────────────────────────────

export const KNIE_EPISODE_ID = "e2evaultknie000000000001";
export const MRT_DOC_ID = "e2evaultmrt0000000000001";
/** Filing date of the MRT report — "last autumn" relative to the fixture. */
const MRT_DOC_DATE = "2025-10-14";

const FIXTURE_KINDS = [
  "DOCTOR_REPORT",
  "LAB_RESULT",
  "PRESCRIPTION",
  "IMAGING",
  "OTHER",
  "DISCHARGE_LETTER",
  "INSURANCE",
] as const;

interface DocRow {
  id: string;
  kind: string;
  title: string;
  filename: string;
  mimeType: string;
  documentDate: string; // YYYY-MM-DD
  bytes: Buffer;
}

async function getUserId(pool: pg.Pool): Promise<string> {
  const res = await pool.query<{ id: string }>(
    "SELECT id FROM users WHERE username = $1",
    [E2E_USER.username],
  );
  const id = res.rows[0]?.id;
  if (!id) {
    throw new Error(
      "[vault-fixture] e2e user not seeded — global-setup must run first",
    );
  }
  return id;
}

async function upsertDocs(
  pool: pg.Pool,
  userId: string,
  docs: DocRow[],
): Promise<void> {
  for (const doc of docs) {
    const encrypted = encryptBinary2(doc.bytes);
    const sha = createHash("sha256").update(doc.bytes).digest("hex");
    await pool.query(
      `INSERT INTO inbound_documents
        (id, user_id, kind, title, filename, mime_type, byte_size,
         content_encrypted, content_codec, content_sha256, status,
         document_date, created_at, updated_at, deleted_at)
       VALUES ($1, $2, $3::inbound_document_kind, $4, $5, $6, $7,
               $8, 'binary2', $9, 'STORED',
               $10::timestamp, NOW(), NOW(), NULL)
       ON CONFLICT (id) DO UPDATE SET
         kind = EXCLUDED.kind,
         title = EXCLUDED.title,
         document_date = EXCLUDED.document_date,
         status = 'STORED',
         deleted_at = NULL,
         updated_at = NOW()`,
      [
        doc.id,
        userId,
        doc.kind,
        doc.title,
        doc.filename,
        doc.mimeType,
        doc.bytes.byteLength,
        encrypted,
        sha,
        `${doc.documentDate}T00:00:00Z`,
      ],
    );
  }
}

/**
 * Enable the vault module for the seeded e2e user and plant the doctor-flow
 * corpus. Safe to call from every spec's beforeAll — every statement
 * upserts.
 */
export async function ensureVaultFixture(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("[vault-fixture] DATABASE_URL is not set");
  const pool = new pg.Pool({ connectionString: url });
  try {
    const userId = await getUserId(pool);

    // Opt-in module: merge, never overwrite other module preferences.
    await pool.query(
      `UPDATE users
       SET module_preferences_json =
         COALESCE(module_preferences_json, '{}'::jsonb)
         || '{"inboundDocuments": true}'::jsonb
       WHERE id = $1`,
      [userId],
    );

    // The "Knie" condition episode the MRT report files under.
    await pool.query(
      `INSERT INTO illness_episodes
        (id, user_id, label, type, lifecycle, onset_at, created_at, updated_at)
       VALUES ($1, $2, 'Knie', 'INJURY', 'ACUTE', '2025-09-01T00:00:00Z', NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET
         label = EXCLUDED.label, deleted_at = NULL, updated_at = NOW()`,
      [KNIE_EPISODE_ID, userId],
    );

    // 60 background documents spread over 36 months (newest ~current).
    const docs: DocRow[] = [];
    for (let i = 0; i < 60; i++) {
      const monthsBack = Math.floor((i * 36) / 60);
      const anchor = new Date(Date.UTC(2026, 5 - monthsBack, 1 + (i % 25)));
      const id = `e2evaultdoc${String(i).padStart(12, "0")}`;
      docs.push({
        id,
        kind: FIXTURE_KINDS[i % FIXTURE_KINDS.length],
        title: `Befund ${String(i + 1).padStart(2, "0")}`,
        filename: `befund-${i + 1}.pdf`,
        mimeType: "application/pdf",
        documentDate: anchor.toISOString().slice(0, 10),
        bytes: tinyPdf(id),
      });
    }
    // The MRT report + two adjacent images, same date, all linked to Knie.
    docs.push({
      id: MRT_DOC_ID,
      kind: "IMAGING",
      title: "MRT Knie",
      filename: "mrt-knie.pdf",
      mimeType: "application/pdf",
      documentDate: MRT_DOC_DATE,
      bytes: tinyPdf(MRT_DOC_ID),
    });
    for (const n of [1, 2]) {
      docs.push({
        id: `e2evaultimg000000000000${n}`,
        kind: "IMAGING",
        title: `MRT Aufnahme ${n}`,
        filename: `mrt-aufnahme-${n}.png`,
        mimeType: "image/png",
        documentDate: MRT_DOC_DATE,
        bytes: tinyPng(`e2evaultimg${n}`),
      });
    }
    await upsertDocs(pool, userId, docs);

    // Condition links for the three MRT-day documents.
    const linked = [
      MRT_DOC_ID,
      "e2evaultimg0000000000001",
      "e2evaultimg0000000000002",
    ];
    for (const [i, docId] of linked.entries()) {
      await pool.query(
        `INSERT INTO document_condition_links
          (id, document_id, episode_id, user_id, created_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (document_id, episode_id) DO NOTHING`,
        [`e2evaultlink00000000000${i + 1}`, docId, KNIE_EPISODE_ID, userId],
      );
    }
  } finally {
    await pool.end();
  }
}

/**
 * Seed a disposable, namespaced batch of OTHER-kind PDF documents for the
 * bulk-flow specs (`title`/`filename` carry the prefix so a search filter
 * isolates exactly this namespace). Idempotent; re-runs reset kind/date and
 * clear tombstones so a previous run's mutations never leak into this one.
 */
export async function seedNamespaceDocs(
  prefix: string,
  count: number,
): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("[vault-fixture] DATABASE_URL is not set");
  const pool = new pg.Pool({ connectionString: url });
  try {
    const userId = await getUserId(pool);
    const docs: DocRow[] = [];
    for (let i = 0; i < count; i++) {
      const id = `e2e${prefix}${String(i).padStart(8, "0")}`;
      docs.push({
        id,
        kind: "OTHER",
        title: `${prefix} ${String(i + 1).padStart(3, "0")}`,
        filename: `${prefix}-${i + 1}.pdf`,
        mimeType: "application/pdf",
        // One shared filing date: the timeline then orders the namespace by
        // the id tiebreak (desc), so `${prefix} <count>` renders first and
        // `${prefix} 001` last — a deterministic range-selection span.
        documentDate: "2026-05-01",
        bytes: tinyPdf(id),
      });
    }
    await upsertDocs(pool, userId, docs);
  } finally {
    await pool.end();
  }
}
