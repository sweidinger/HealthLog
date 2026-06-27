/**
 * v1.23 — read-only scan + in-place re-encrypt over the whole encrypted-column
 * corpus, driven by the canonical registry (`encrypted-columns.ts`).
 *
 * Two consumers:
 *   - the admin encryption-status view (`GET /api/admin/encryption/status`)
 *     calls `scanCorpus()` to bucket every encrypted column's rows by key id;
 *   - the admin-triggered rotation pg-boss job (`encryption-key-rotate`) calls
 *     `rotateCorpus()` to re-encrypt every row that is not already on the
 *     active key.
 *
 * The standalone CLI (`scripts/rotate-encryption-key.ts`) remains the canonical
 * rotation path and stays independent (its own Prisma client). This module is
 * the in-app convenience that reuses the SAME registry, so the guard test keeps
 * both in lock-step.
 *
 * GUARANTEES (the security review must confirm these on the rotation path):
 *  - ACTIVE-KEY-ONLY. Re-encryption is `encrypt(decrypt(value))`; `encrypt()`
 *    always writes the configured active key id. There is no code path here
 *    that selects any other write key.
 *  - NEVER ADDS / DROPS A KEY. This module never reads or mutates
 *    `ENCRYPTION_KEYS` / `ENCRYPTION_ACTIVE_KEY_ID`. The operator's env key map
 *    is the only place keys live; a key drop stays a deliberate env + redeploy
 *    act, never a button.
 *  - IDEMPOTENT. `shouldRotate()` skips rows already on the active key, so a
 *    second pass (or two racing workers) re-encrypts zero rows.
 *  - FAIL-CLOSED. A row written under a key id that is no longer configured
 *    throws on decrypt (counted as an error, the row is left untouched) rather
 *    than being silently dropped or overwritten — exactly the property that
 *    protects against dropping a legacy key too early.
 */
import { Buffer } from "node:buffer";
import { decrypt, encrypt, extractKeyId, getActiveKeyId } from "@/lib/crypto";
import {
  ENCRYPTED_COLUMNS,
  encryptedColumnKey,
  type EncryptedColumn,
} from "@/lib/crypto/encrypted-columns";

/** Sentinel bucket for legacy (unversioned) ciphertext under `byKeyId`. */
export const LEGACY_BUCKET = "legacy";

/** Minimal Prisma delegate shape this module needs. */
interface ColumnDelegate {
  findMany: (args: {
    select: Record<string, true>;
  }) => Promise<Array<Record<string, unknown>>>;
  update: (args: {
    where: { id: string };
    data: Record<string, unknown>;
  }) => Promise<unknown>;
}

/** The subset of the Prisma client we touch: one delegate per model. */
export type CorpusClient = Record<string, ColumnDelegate>;

/** PascalCase model name -> camelCase Prisma delegate key. */
function delegateKey(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

function getDelegate(client: CorpusClient, model: string): ColumnDelegate {
  const delegate = client[delegateKey(model)];
  if (!delegate) {
    throw new Error(`No Prisma delegate for model '${model}'`);
  }
  return delegate;
}

/** Read a registry column's value as a ciphertext string (Bytes -> utf8). */
function toCiphertext(
  value: unknown,
  kind: EncryptedColumn["kind"],
): string | null {
  if (value == null) return null;
  if (kind === "bytes") {
    const buf = value as Uint8Array;
    if (buf.byteLength === 0) return null;
    return Buffer.from(buf).toString("utf8");
  }
  const s = value as string;
  return s.length === 0 ? null : s;
}

/** Encode a re-encrypted ciphertext string back into the column's storage shape. */
function fromCiphertext(
  value: string,
  kind: EncryptedColumn["kind"],
): string | Uint8Array {
  if (kind !== "bytes") return value;
  const encoded = Buffer.from(value, "utf8");
  const next = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  next.set(encoded);
  return next;
}

function shouldRotate(ciphertext: string): boolean {
  return extractKeyId(ciphertext) !== getActiveKeyId();
}

export interface ColumnScan {
  model: string;
  field: string;
  kind: EncryptedColumn["kind"];
  /** Non-null ciphertext rows. */
  total: number;
  /** Rows per key id; legacy/unversioned rows land under `LEGACY_BUCKET`. */
  byKeyId: Record<string, number>;
  /** Rows under the legacy/unversioned format (= `byKeyId[LEGACY_BUCKET]`). */
  legacy: number;
}

/** Scan one encrypted column: bucket every non-null ciphertext by key id. */
export async function scanColumn(
  client: CorpusClient,
  col: EncryptedColumn,
): Promise<ColumnScan> {
  const delegate = getDelegate(client, col.model);
  const rows = await delegate.findMany({
    select: { id: true, [col.field]: true },
  });
  const byKeyId: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    const ciphertext = toCiphertext(row[col.field], col.kind);
    if (ciphertext == null) continue;
    total += 1;
    const id = extractKeyId(ciphertext) ?? LEGACY_BUCKET;
    byKeyId[id] = (byKeyId[id] ?? 0) + 1;
  }
  return {
    model: col.model,
    field: col.field,
    kind: col.kind,
    total,
    byKeyId,
    legacy: byKeyId[LEGACY_BUCKET] ?? 0,
  };
}

export interface CorpusScan {
  activeKeyId: string;
  columns: ColumnScan[];
  /** Total non-null ciphertext rows across the corpus. */
  totalRows: number;
  /** Rows already on the active key. */
  activeRows: number;
  /** Rows NOT on the active key (legacy + any non-active versioned). */
  staleRows: number;
  /**
   * True iff every column has zero rows that are not on the active key — the
   * single signal an operator needs before dropping a legacy key.
   */
  rotationComplete: boolean;
}

/** Scan the whole corpus. Read-only; never writes. */
export async function scanCorpus(client: CorpusClient): Promise<CorpusScan> {
  const activeKeyId = getActiveKeyId();
  const columns: ColumnScan[] = [];
  for (const col of ENCRYPTED_COLUMNS) {
    columns.push(await scanColumn(client, col));
  }
  let totalRows = 0;
  let activeRows = 0;
  for (const c of columns) {
    totalRows += c.total;
    activeRows += c.byKeyId[activeKeyId] ?? 0;
  }
  const staleRows = totalRows - activeRows;
  return {
    activeKeyId,
    columns,
    totalRows,
    activeRows,
    staleRows,
    rotationComplete: staleRows === 0,
  };
}

export interface RotationResult {
  model: string;
  field: string;
  scanned: number;
  rotated: number;
  errors: number;
}

/** Re-encrypt one column's stale rows to the active key. */
export async function rotateColumn(
  client: CorpusClient,
  col: EncryptedColumn,
): Promise<RotationResult> {
  const delegate = getDelegate(client, col.model);
  const rows = await delegate.findMany({
    select: { id: true, [col.field]: true },
  });
  const result: RotationResult = {
    model: col.model,
    field: col.field,
    scanned: rows.length,
    rotated: 0,
    errors: 0,
  };
  for (const row of rows) {
    const ciphertext = toCiphertext(row[col.field], col.kind);
    if (ciphertext == null || !shouldRotate(ciphertext)) continue;
    const id = row.id as string;
    try {
      // ACTIVE-KEY-ONLY: encrypt() always writes the active key id.
      const reencrypted = encrypt(decrypt(ciphertext));
      await delegate.update({
        where: { id },
        data: { [col.field]: fromCiphertext(reencrypted, col.kind) },
      });
      result.rotated += 1;
    } catch {
      // FAIL-CLOSED: a row under a no-longer-configured key throws on decrypt;
      // count it and leave the row untouched rather than dropping data.
      result.errors += 1;
    }
  }
  return result;
}

export interface CorpusRotation {
  activeKeyId: string;
  results: RotationResult[];
  totalScanned: number;
  totalRotated: number;
  totalErrors: number;
}

/** Re-encrypt the whole corpus to the active key. Idempotent + active-key-only. */
export async function rotateCorpus(
  client: CorpusClient,
): Promise<CorpusRotation> {
  const activeKeyId = getActiveKeyId();
  const results: RotationResult[] = [];
  for (const col of ENCRYPTED_COLUMNS) {
    results.push(await rotateColumn(client, col));
  }
  let totalScanned = 0;
  let totalRotated = 0;
  let totalErrors = 0;
  for (const r of results) {
    totalScanned += r.scanned;
    totalRotated += r.rotated;
    totalErrors += r.errors;
  }
  return {
    activeKeyId,
    results,
    totalScanned,
    totalRotated,
    totalErrors,
  };
}

export { encryptedColumnKey };
