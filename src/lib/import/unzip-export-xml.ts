/**
 * Minimal `export.zip` extractor — pulls `apple_health_export/export.xml`
 * out of an Apple Health export archive without spawning a third-party
 * dependency.
 *
 * Why hand-rolled: every iOS Apple Health export lands as a single
 * deflate-compressed ZIP archive. Pulling in `yauzl` / `adm-zip` / etc.
 * for one file we only ever read once would balloon the build graph
 * (and `yauzl` ships a non-trivial number of transitive deps). Node 22
 * ships `node:zlib` already; the only missing piece is a tiny ZIP
 * central-directory walker.
 *
 * Coverage scope:
 *   - Stored entries (compression method 0) — copy bytes verbatim.
 *   - Deflated entries (compression method 8) — streamed through
 *     `zlib.createInflateRaw()`.
 *   - Encrypted entries → unsupported (Apple does not encrypt the
 *     export.zip; reject with a clear error).
 *   - Zip64 — supported for the central directory record (Apple
 *     exports easily push past the 4 GB limit on multi-year accounts).
 *
 * v1.32.1 (issue #588) — extracting the member used to run through
 * `inflateRawSync()` on a single in-memory buffer holding the WHOLE
 * inflated `export.xml` (up to `MAX_DECOMPRESSED_BYTES`) at the same
 * time the compressed-archive buffer was still resident, then
 * `writeFileSync()`'d the result in one blocking call. `extractExportXml`
 * runs on the same event loop as the web server in the default
 * single-container deployment (`src/instrumentation.ts` starts the
 * pg-boss worker in-process), so that synchronous path could pin the
 * Node main thread for minutes on a real multi-year export — freezing
 * every other request the app was serving — while briefly needing
 * roughly 2x the decompressed size in JS heap. A user hitting this saw
 * an import that never leaves "Unpacking the archive…": the phase
 * label is written to `ImportJob.status` BEFORE extraction starts and
 * only advances once `extractExportXml()` returns, so a process that
 * dies mid-extraction (OOM, restart) before that return leaves the row
 * silently stuck with no failure ever recorded. The member now streams
 * through `zlib.createInflateRaw()` into a file write stream —
 * decompression work moves off the JS event loop onto the libuv
 * threadpool in bounded chunks, and peak memory is bounded by the
 * chunk size rather than the whole decompressed payload. The
 * `MAX_DECOMPRESSED_BYTES` zip-bomb defence moves with it: the
 * streaming inflate API has no `maxOutputLength` option, so a
 * byte-counting transform enforces the cap on the real output as it
 * flows.
 *
 * Locks per `.planning/research/v1434-r-1-xml-import.md` §6.1.
 */
import { readFileSync, createWriteStream, statSync, unlinkSync } from "node:fs";
import { createInflateRaw } from "node:zlib";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Signature bytes for the End-Of-Central-Directory record. */
const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_LOCATOR = 0x07064b50;
const ZIP64_EOCD_RECORD = 0x06064b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

/**
 * Hard cap on the decompressed `export.xml` size. Apple Health exports
 * for heavy multi-year accounts settle in the low single-digit GB
 * range; 8 GiB leaves a wide ceiling for any legitimate user while
 * making zip-bomb expansion (1000:1 deflate ratios are easily
 * crafted) refuse the inflate before it OOMs the process.
 */
const MAX_DECOMPRESSED_BYTES = 8 * 1024 * 1024 * 1024;
/**
 * Pre-flight refusal threshold for the central-directory's advertised
 * ratio. Legitimate Apple Health XML compresses at maybe 10–20× under
 * DEFLATE; anything claiming a 200× expansion is a synthesized bomb.
 * This is a coarse signal — the byte-counting cap on the streamed
 * inflate output (`streamEntryToFile()` below) is the load-bearing
 * defence.
 */
const MAX_COMPRESSION_RATIO = 200;

/** Chunk size fed into the inflate/write pipeline per `write()` call. */
const STREAM_CHUNK_BYTES = 1 * 1024 * 1024;

/** A single entry within the archive's central directory. */
interface CentralDirectoryEntry {
  fileName: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/**
 * Result of `extractExportXml()`. The XML is written to a temp file
 * because the streaming SAX parser expects a path it can `createReadStream`
 * against.
 */
export interface UnzipResult {
  /** Filesystem path the extracted `export.xml` lives at. */
  xmlPath: string;
  /** Uncompressed size in bytes of the extracted XML. */
  xmlBytes: number;
  /** Members the parser ignored (everything other than `export.xml`). */
  otherMembers: { name: string; bytes: number }[];
}

/**
 * Walk the central directory of `archivePath` and write the
 * `apple_health_export/export.xml` member out to a temp file.
 * Throws when the member is missing, encrypted, or compressed with
 * an unsupported method.
 */
export async function extractExportXml(
  archivePath: string,
): Promise<UnzipResult> {
  const buf = readFileSync(archivePath);
  const entries = readCentralDirectory(buf);

  const exportXmlEntry = entries.find(
    (e) => e.fileName.endsWith("/export.xml") || e.fileName === "export.xml",
  );
  if (!exportXmlEntry) {
    throw new Error(
      "Archive is missing the `apple_health_export/export.xml` member" +
        " — is this a valid Apple Health export.zip?",
    );
  }

  if (
    exportXmlEntry.compressionMethod !== 0 &&
    exportXmlEntry.compressionMethod !== 8
  ) {
    throw new Error(
      `Unsupported ZIP compression method ${exportXmlEntry.compressionMethod}` +
        " for export.xml (expected 0=stored or 8=deflate)",
    );
  }

  // Pre-flight zip-bomb defence. The central directory's advertised
  // `uncompressedSize` is attacker-controlled (a malicious archive can
  // lie), so this catches honest-but-oversized payloads early; the
  // load-bearing defence is the byte-counting cap inside
  // `streamEntryToFile()` which trips on the actual inflate output.
  if (exportXmlEntry.uncompressedSize > MAX_DECOMPRESSED_BYTES) {
    throw new Error(
      `export.xml declares an uncompressed size of ${exportXmlEntry.uncompressedSize} bytes` +
        ` — refusing to extract (cap is ${MAX_DECOMPRESSED_BYTES} bytes).`,
    );
  }
  if (
    exportXmlEntry.compressedSize > 0 &&
    exportXmlEntry.uncompressedSize / exportXmlEntry.compressedSize >
      MAX_COMPRESSION_RATIO
  ) {
    throw new Error(
      `export.xml advertises a ${(
        exportXmlEntry.uncompressedSize / exportXmlEntry.compressedSize
      ).toFixed(0)}× compression ratio (cap is ${MAX_COMPRESSION_RATIO}×)` +
        " — refusing as a suspected zip bomb.",
    );
  }

  const xmlPath = join(
    tmpdir(),
    `healthlog-import-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.xml`,
  );
  const xmlBytes = await streamEntryToFile(buf, exportXmlEntry, xmlPath);

  const otherMembers = entries
    .filter((e) => e !== exportXmlEntry)
    .map((e) => ({ name: e.fileName, bytes: e.uncompressedSize }));

  return {
    xmlPath,
    xmlBytes,
    otherMembers,
  };
}

/**
 * Walk the ZIP central directory and return one descriptor per member.
 * Exported for unit testing the central-directory parser independently
 * of the file-extraction path.
 */
export function readCentralDirectory(buf: Buffer): CentralDirectoryEntry[] {
  const eocdOffset = locateEocd(buf);
  if (eocdOffset === -1) {
    throw new Error("Could not locate ZIP End-Of-Central-Directory record");
  }

  let centralDirSize = buf.readUInt32LE(eocdOffset + 12);
  let centralDirOffset = buf.readUInt32LE(eocdOffset + 16);
  let entryCount = buf.readUInt16LE(eocdOffset + 10);

  // Zip64 handling — when any of the three count/offset fields is the
  // 0xFFFFFFFF / 0xFFFF sentinel, the real value lives in the Zip64
  // EOCD record located by walking back through the locator.
  if (
    centralDirOffset === 0xffffffff ||
    centralDirSize === 0xffffffff ||
    entryCount === 0xffff
  ) {
    const locatorOffset = eocdOffset - 20;
    if (
      locatorOffset < 0 ||
      buf.readUInt32LE(locatorOffset) !== ZIP64_EOCD_LOCATOR
    ) {
      throw new Error("Zip64 sentinels present but Zip64 locator missing");
    }
    const zip64EocdOffset = Number(buf.readBigUInt64LE(locatorOffset + 8));
    if (buf.readUInt32LE(zip64EocdOffset) !== ZIP64_EOCD_RECORD) {
      throw new Error("Zip64 EOCD record signature mismatch");
    }
    entryCount = Number(buf.readBigUInt64LE(zip64EocdOffset + 32));
    centralDirSize = Number(buf.readBigUInt64LE(zip64EocdOffset + 40));
    centralDirOffset = Number(buf.readBigUInt64LE(zip64EocdOffset + 48));
  }

  const entries: CentralDirectoryEntry[] = [];
  let cursor = centralDirOffset;
  const end = centralDirOffset + centralDirSize;
  while (cursor < end && entries.length < entryCount) {
    if (buf.readUInt32LE(cursor) !== CENTRAL_FILE_HEADER) {
      throw new Error(
        `Central directory entry ${entries.length} has wrong signature`,
      );
    }
    const compressionMethod = buf.readUInt16LE(cursor + 10);
    const flags = buf.readUInt16LE(cursor + 8);
    if (flags & 0x0001) {
      throw new Error("Encrypted ZIP entries are not supported");
    }
    const compressedSize32 = buf.readUInt32LE(cursor + 20);
    const uncompressedSize32 = buf.readUInt32LE(cursor + 24);
    const fileNameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localHeaderOffset32 = buf.readUInt32LE(cursor + 42);

    const fileName = buf
      .slice(cursor + 46, cursor + 46 + fileNameLen)
      .toString("utf8");

    let compressedSize = compressedSize32;
    let uncompressedSize = uncompressedSize32;
    let localHeaderOffset = localHeaderOffset32;

    // Zip64 extra-field walk if any of the three values is sentinel.
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      const extraStart = cursor + 46 + fileNameLen;
      let extraCursor = extraStart;
      const extraEnd = extraStart + extraLen;
      while (extraCursor + 4 <= extraEnd) {
        const headerId = buf.readUInt16LE(extraCursor);
        const dataSize = buf.readUInt16LE(extraCursor + 2);
        if (headerId === 0x0001) {
          // Zip64 extended-info extra field
          let dCursor = extraCursor + 4;
          if (uncompressedSize === 0xffffffff) {
            uncompressedSize = Number(buf.readBigUInt64LE(dCursor));
            dCursor += 8;
          }
          if (compressedSize === 0xffffffff) {
            compressedSize = Number(buf.readBigUInt64LE(dCursor));
            dCursor += 8;
          }
          if (localHeaderOffset === 0xffffffff) {
            localHeaderOffset = Number(buf.readBigUInt64LE(dCursor));
            dCursor += 8;
          }
          break;
        }
        extraCursor += 4 + dataSize;
      }
    }

    entries.push({
      fileName,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });

    cursor += 46 + fileNameLen + extraLen + commentLen;
  }

  return entries;
}

/**
 * Split a Buffer into fixed-size slices (no copying — `subarray` views
 * share the backing memory) so the inflate/write pipeline processes the
 * entry in bounded chunks instead of one giant `write()` call.
 */
function* chunkBuffer(buf: Buffer, size: number): Generator<Buffer> {
  for (let offset = 0; offset < buf.length; offset += size) {
    yield buf.subarray(offset, Math.min(offset + size, buf.length));
  }
}

/**
 * Byte-counting passthrough that refuses to forward more than `limit`
 * bytes — the streaming equivalent of `inflateRawSync`'s
 * `maxOutputLength`, since the Transform-based zlib API exposes no such
 * option. Trips on the actual bytes flowing through even when the
 * central-directory metadata lied about the uncompressed size. Exported
 * so a unit test can exercise the cap directly against a small limit —
 * the real `MAX_DECOMPRESSED_BYTES` ceiling (8 GiB) is not practical to
 * trip from a test fixture.
 */
export function createByteCap(limit: number): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, callback) {
      total += chunk.length;
      if (total > limit) {
        callback(
          new Error(
            `Decompressed export.xml exceeds the ${limit}-byte cap` +
              " — refusing as a suspected zip bomb.",
          ),
        );
        return;
      }
      callback(null, chunk);
    },
  });
}

/**
 * Stream a single ZIP entry's bytes out to `destPath`, decompressing
 * through `zlib.createInflateRaw()` when needed. Runs entirely off the
 * JS main thread (stream I/O + the libuv-threadpool-backed zlib
 * binding), so a multi-GB member no longer blocks the event loop the
 * way the old `inflateRawSync()` + `writeFileSync()` pair did. Returns
 * the number of bytes written.
 */
async function streamEntryToFile(
  buf: Buffer,
  entry: CentralDirectoryEntry,
  destPath: string,
): Promise<number> {
  const local = entry.localHeaderOffset;
  if (buf.readUInt32LE(local) !== LOCAL_FILE_HEADER) {
    throw new Error(
      `Local file header for ${entry.fileName} has wrong signature`,
    );
  }
  const localFileNameLen = buf.readUInt16LE(local + 26);
  const localExtraLen = buf.readUInt16LE(local + 28);
  const dataStart = local + 30 + localFileNameLen + localExtraLen;
  const compressed = buf.subarray(dataStart, dataStart + entry.compressedSize);

  const source = Readable.from(chunkBuffer(compressed, STREAM_CHUNK_BYTES));
  const dest = createWriteStream(destPath);
  const cap = createByteCap(MAX_DECOMPRESSED_BYTES);

  try {
    if (entry.compressionMethod === 0) {
      await pipeline(source, cap, dest);
    } else {
      // Method 8 — DEFLATE, streamed through the async zlib Transform.
      await pipeline(source, createInflateRaw(), cap, dest);
    }
  } catch (err) {
    // A mid-stream failure (byte cap trip, corrupt deflate stream) can
    // leave a partial file on disk — the old sync path only ever wrote
    // once inflate had already fully succeeded. Clean up so a rejected
    // archive doesn't leak a partial `/tmp` file.
    try {
      unlinkSync(destPath);
    } catch {
      // ignore — best-effort
    }
    throw err;
  }
  return statSync(destPath).size;
}

/**
 * Scan backwards from the end of the buffer for the EOCD signature.
 * The EOCD lives in the last 22 + comment bytes; a comment is rare in
 * the Health export but we tolerate up to 64 KB just in case.
 */
function locateEocd(buf: Buffer): number {
  const searchStart = Math.max(0, buf.length - (22 + 0x10000));
  for (let i = buf.length - 22; i >= searchStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}
