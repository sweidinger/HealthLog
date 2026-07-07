/**
 * v1.27.22 (Document vault P2) — the blind content-search index.
 *
 * Content search matches INSIDE a stored document without ever keeping its body
 * readable at rest. Two derived artefacts live in `DocumentContentIndex`:
 *
 *   1. `textEncrypted` — the normalised extracted text, AES-256-GCM at rest via
 *      the shared `encrypt()`-string-as-UTF-8 Bytes codec (same posture as the
 *      Coach columns). Recoverable server-side so key rotation can re-tokenise.
 *   2. `searchTokens` — each unique normalised token HMAC-SHA256'd under an
 *      HKDF-derived index subkey, truncated to a short hex tag. Deterministic
 *      (the same token always hashes to the same tag) so a query can be hashed
 *      the same way and matched with a GIN-accelerated array-overlap; one-way
 *      (opaque without the server-held subkey), so nothing readable is stored.
 *
 * The index subkey is HKDF-derived from the ACTIVE encryption key (P2-D7), never
 * the raw master key or the HMAC auth key. Because it follows the active key,
 * rotating the master key changes the subkey — the rotation script re-tokenises
 * every row from the decrypted `textEncrypted` so search keeps matching.
 *
 * Honest limit (P2-D6): the token index does WHOLE-TOKEN equality only — no
 * substring, prefix, or fuzzy matching. The vault list keeps the title/filename
 * ILIKE for substring on the short fields and unions the two result sets.
 */
import { createHmac } from "node:crypto";

import { decryptFromBytes, encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { deriveSubkey } from "@/lib/crypto";
import { prisma } from "@/lib/db";

/**
 * Tokeniser algorithm version. Bump when the normalisation / tokenisation rules
 * change so a re-index can be detected unambiguously; it is orthogonal to the
 * index subkey (which follows the encryption key, not this version).
 */
export const CONTENT_TOKENIZER_VERSION = "1";

/** HKDF domain-separation label for the index HMAC subkey (P2-D7). */
const INDEX_SUBKEY_INFO = "healthlog:document-content-index:v1";

/** Minimum token length kept — drop 1-2 char noise ("mg", "x"). */
const MIN_TOKEN_LENGTH = 3;

/** Maximum token length kept — clamp a runaway OCR mash-up. */
const MAX_TOKEN_LENGTH = 64;

/** Cap on unique tokens stored per document — bounds the array + GIN entry. */
export const MAX_TOKENS_PER_DOCUMENT = 2048;

/**
 * Cap on the normalised text kept at rest per document (~64 KiB). The full body
 * is only needed to re-tokenise on rotation; a bounded prefix keeps the sibling
 * row lean and the token set representative without hoarding an unbounded blob.
 */
export const MAX_INDEX_TEXT_BYTES = 64 * 1024;

/** Cap on query tokens hashed for a search (a search box, not a corpus). */
const MAX_QUERY_TOKENS = 24;

/**
 * A compact de/en stopword set. Dropping the highest-frequency function words
 * keeps the token array (and the GIN index) focused on content terms; a missed
 * stopword only wastes a slot, never a correctness bug.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  // English
  "the", "and", "for", "are", "was", "with", "that", "this", "have", "has",
  "not", "from", "you", "your", "his", "her", "she", "him", "they", "them",
  "were", "which", "who", "whom", "what", "when", "where", "will", "would",
  "there", "their", "been", "than", "then", "into", "out", "off", "per",
  // German
  "und", "der", "die", "das", "den", "dem", "des", "ein", "eine", "einer",
  "eines", "einem", "einen", "ist", "sind", "war", "waren", "wird", "werden",
  "nicht", "auch", "auf", "aus", "bei", "mit", "nach", "von", "vom", "zur",
  "zum", "für", "durch", "oder", "aber", "dass", "wie", "wenn", "sich", "als",
  "sowie", "wurde", "wurden", "bzw", "ggf",
]);

/**
 * Normalise raw extracted text: lowercase, strip diacritics (NFKD →
 * combining-mark removal), and cap to the storage budget. The cap is applied on
 * the byte length so the `textEncrypted` payload stays bounded regardless of
 * multi-byte content.
 */
export function normaliseIndexText(raw: string): string {
  const lowered = raw
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
  // Byte-bounded truncation — slice by chars until the UTF-8 length fits.
  if (Buffer.byteLength(lowered, "utf8") <= MAX_INDEX_TEXT_BYTES) return lowered;
  let out = lowered.slice(0, MAX_INDEX_TEXT_BYTES);
  while (Buffer.byteLength(out, "utf8") > MAX_INDEX_TEXT_BYTES) {
    out = out.slice(0, -256);
  }
  return out;
}

/**
 * Split normalised text into the deduped set of index tokens: alphanumeric
 * runs, length-gated, stopword-dropped, unique, capped. Insertion order is
 * preserved so the cap keeps the earliest-seen terms.
 */
export function tokenise(text: string): string[] {
  const normalised = normaliseIndexText(text);
  const seen = new Set<string>();
  // Split on anything that is not a letter or digit (Unicode-aware).
  for (const rawToken of normalised.split(/[^\p{L}\p{N}]+/u)) {
    if (seen.size >= MAX_TOKENS_PER_DOCUMENT) break;
    const token = rawToken.trim();
    if (token.length < MIN_TOKEN_LENGTH || token.length > MAX_TOKEN_LENGTH) {
      continue;
    }
    if (STOPWORDS.has(token)) continue;
    seen.add(token);
  }
  return [...seen];
}

/** The HKDF-derived HMAC subkey for the blind index. Never persisted or logged. */
function indexSubkey(): Buffer {
  return deriveSubkey(INDEX_SUBKEY_INFO);
}

/** HMAC-SHA256 one token under the index subkey; truncated to a 16-char hex tag. */
function hashToken(token: string, subkey: Buffer): string {
  return createHmac("sha256", subkey).update(token, "utf8").digest("hex").slice(0, 16);
}

/**
 * Turn extracted text into the deduped array of blind token hashes to persist.
 * Deterministic under the active index subkey; opaque without it.
 */
export function tokeniseAndHash(text: string): string[] {
  const subkey = indexSubkey();
  const tokens = tokenise(text);
  const hashes = new Set<string>();
  for (const token of tokens) hashes.add(hashToken(token, subkey));
  return [...hashes];
}

/**
 * Hash a user's search query into the token tags to match against the index.
 * Same normalisation + subkey as `tokeniseAndHash`, so a whole-word hit in the
 * body produces the same tag. Returns [] when the query has no indexable token
 * (the caller then skips the content-match branch).
 */
export function hashQueryTokens(query: string): string[] {
  const subkey = indexSubkey();
  const tokens = tokenise(query).slice(0, MAX_QUERY_TOKENS);
  const hashes = new Set<string>();
  for (const token of tokens) hashes.add(hashToken(token, subkey));
  return [...hashes];
}

/** Encrypt normalised index text into the `Bytes` payload the schema stores. */
export function encryptIndexText(text: string): Uint8Array<ArrayBuffer> {
  return encryptToBytes(text);
}

/** Decrypt a stored index-text payload back to its plaintext. Throws on bad key. */
export function decryptIndexText(buf: Uint8Array): string {
  return decryptFromBytes(buf);
}

/** Provenance of the indexed text. */
export type ContentIndexSource = "vision" | "text-ocr";

export interface UpsertContentIndexArgs {
  userId: string;
  documentId: string;
  /** Raw extracted text (normalised + capped inside). */
  text: string;
  source: ContentIndexSource;
  /** Provider type that produced the text (null on the text-ocr path). */
  providerType?: string | null;
}

/**
 * Populate or refresh one document's content index. Normalises + caps the text,
 * encrypts it, tokenises + hashes it, and upserts the 1:1 sibling row. Storing
 * only ciphertext + opaque hashes preserves the vault's encryption-at-rest
 * promise (A4). Idempotent — a re-index overwrites both artefacts in place.
 */
export async function upsertContentIndex(
  args: UpsertContentIndexArgs,
): Promise<{ tokenCount: number }> {
  const normalised = normaliseIndexText(args.text);
  const textEncrypted = encryptIndexText(normalised);
  const searchTokens = tokeniseAndHash(normalised);
  await prisma.documentContentIndex.upsert({
    where: { documentId: args.documentId },
    create: {
      documentId: args.documentId,
      userId: args.userId,
      textEncrypted,
      searchTokens,
      source: args.source,
      providerType: args.providerType ?? null,
      tokenizerVersion: CONTENT_TOKENIZER_VERSION,
    },
    update: {
      textEncrypted,
      searchTokens,
      source: args.source,
      providerType: args.providerType ?? null,
      tokenizerVersion: CONTENT_TOKENIZER_VERSION,
    },
  });
  return { tokenCount: searchTokens.length };
}
