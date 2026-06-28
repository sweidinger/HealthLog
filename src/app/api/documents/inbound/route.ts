/**
 * v1.25 — documents library: store-first upload + browsable list.
 *
 * POST is STORE-ONLY and provider-free. A self-hoster uploads any clinical
 * document; it is stored ENCRYPTED at rest with `status: STORED` and NO
 * extraction run. There is no provider resolution, no AI consent guard, no
 * budget, and NO egress on this path — a file can always be filed, even on an
 * account with no document-scan provider configured. Optional AI extraction is
 * a separate, user-triggered action (`POST /api/documents/inbound/[id]/extract`).
 *
 * GET lists the caller's documents with title/filename search, a category
 * filter, a `documentDate` range, sort, and keyset pagination — all through the
 * parameter-bound Prisma query builder (no raw SQL).
 *
 * The document is UNTRUSTED (prompt-injection): the server never acts on an
 * instruction inside it. Storing it does nothing with its contents; the later
 * review-then-confirm step is the safety boundary for any extracted facts.
 */
import { Buffer } from "node:buffer";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import {
  encryptDocumentToBytes,
  serialiseDocument,
} from "@/lib/documents/store";
import {
  BodyTooLargeError,
  detectOcrMimeType,
  OCR_MAX_BYTES,
  readBoundedBody,
} from "@/lib/labs/ocr-upload";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import {
  documentCreateSchema,
  documentListQuerySchema,
} from "@/lib/validations/inbound-documents";
import type { Prisma } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

/**
 * A store-only upload touches no provider — the only abuse vector is disk, so
 * a generous per-user ceiling is enough (extraction has its own tight gate).
 */
const UPLOAD_LIMIT_PER_HOUR = 60;
const UPLOAD_WINDOW_MS = 60 * 60 * 1000;

/** Parse a YYYY-MM-DD form field into a UTC midnight Date. */
function isoDateToUtc(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** POST — store an uploaded document encrypted at rest. No extraction. */
export const POST = apiHandler(async (request: Request) => {
  const { user } = await requireAuth();

  // Opt-in module gate — even a valid Bearer token is refused when the surface
  // is off (it ships dark; the user turns it on deliberately).
  const gate = await requireModuleEnabled(user.id, "inboundDocuments");
  if (!gate.enabled) return gate.response;

  const rl = await checkRateLimit(
    `documents-upload:${user.id}`,
    UPLOAD_LIMIT_PER_HOUR,
    UPLOAD_WINDOW_MS,
  );
  if (!rl.allowed) {
    const response = apiError("Too many uploads. Try again later.", 429, {
      errorCode: "documents.inbound.rateLimited",
    });
    for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
      response.headers.set(k, v);
    }
    return response;
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > OCR_MAX_BYTES) {
    return apiError("File is too large (max 12 MB).", 413, {
      errorCode: "documents.inbound.fileTooLarge",
    });
  }

  let formData: FormData;
  try {
    const bytes = await readBoundedBody(request.body, OCR_MAX_BYTES);
    formData = await new Response(new Blob([bytes]), {
      headers: { "content-type": request.headers.get("content-type") ?? "" },
    }).formData();
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return apiError("File is too large (max 12 MB).", 413, {
        errorCode: "documents.inbound.fileTooLarge",
      });
    }
    return apiError("Invalid multipart body", 400);
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return apiError("Field 'file' must be a file", 422);
  }

  // Optional metadata (title / kind / documentDate). The file is read
  // separately; these are the form fields beside it.
  const parsed = documentCreateSchema.safeParse({
    title: formData.get("title") ?? undefined,
    kind: formData.get("kind") ?? undefined,
    documentDate: formData.get("documentDate") ?? undefined,
  });
  if (!parsed.success) {
    return apiError("Invalid document metadata", 422, {
      errorCode: "documents.inbound.invalidMetadata",
    });
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(await file.arrayBuffer());
  } catch {
    return apiError("Failed to read uploaded file", 400);
  }

  const mime = detectOcrMimeType(buffer);
  if (!mime) {
    return apiError("Upload a JPEG, PNG, WebP, or PDF.", 415, {
      errorCode: "documents.inbound.fileType",
    });
  }

  // No mass assignment — every column is set field-by-field; `userId` comes
  // from the session, never the body. `status` is STORED (the library default);
  // no provider / consent / budget call runs here.
  const document = await prisma.inboundDocument.create({
    data: {
      userId: user.id,
      kind: parsed.data.kind ?? "OTHER",
      title: parsed.data.title ?? null,
      filename: typeof file.name === "string" ? file.name.slice(0, 255) : null,
      mimeType: mime,
      byteSize: buffer.byteLength,
      contentEncrypted: encryptDocumentToBytes(buffer),
      status: "STORED",
      documentDate: parsed.data.documentDate
        ? isoDateToUtc(parsed.data.documentDate)
        : null,
    },
  });

  await auditLog("documents.inbound.store", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { documentId: document.id, mime },
  });

  annotate({
    action: { name: "documents.inbound.store" },
    meta: { documentId: document.id, byteSize: document.byteSize },
  });

  return apiSuccess(
    serialiseDocument(document, { factCount: 0, pendingCount: 0 }),
    201,
  );
});

/** GET — list the caller's documents (search / filter / sort / paginate). */
export const GET = apiHandler(async (request: Request) => {
  const { user } = await requireAuth();

  const gate = await requireModuleEnabled(user.id, "inboundDocuments");
  if (!gate.enabled) return gate.response;

  const url = new URL(request.url);
  const parsed = documentListQuerySchema.safeParse(
    Object.fromEntries(url.searchParams),
  );
  if (!parsed.success) {
    return apiError("Invalid list query", 422, {
      errorCode: "documents.inbound.invalidQuery",
    });
  }
  const { q, kind, from, to, sort, order, cursor, limit } = parsed.data;

  const where: Prisma.InboundDocumentWhereInput = {
    userId: user.id,
    deletedAt: null,
  };
  if (kind) where.kind = kind;
  if (from || to) {
    where.documentDate = {
      ...(from ? { gte: isoDateToUtc(from) } : {}),
      // inclusive end-of-day for the `to` bound
      ...(to ? { lt: new Date(isoDateToUtc(to).getTime() + 86_400_000) } : {}),
    };
  }
  if (q) {
    where.OR = [
      { title: { contains: q, mode: "insensitive" } },
      { filename: { contains: q, mode: "insensitive" } },
    ];
  }

  // Keyset pagination on the sort column + a stable `id` tiebreak; nullable
  // sort columns sort nulls last so undated documents trail.
  const primaryOrder:
    Prisma.InboundDocumentOrderByWithRelationInput | undefined =
    sort === "documentDate"
      ? { documentDate: { sort: order, nulls: "last" } }
      : sort === "title"
        ? { title: { sort: order, nulls: "last" } }
        : { createdAt: order };
  const orderBy: Prisma.InboundDocumentOrderByWithRelationInput[] = [
    primaryOrder,
    { id: order },
  ];

  const rows = await prisma.inboundDocument.findMany({
    where,
    orderBy,
    include: {
      _count: { select: { facts: true } },
      facts: { where: { status: "PENDING" }, select: { id: true } },
    },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;

  annotate({
    action: { name: "documents.inbound.list" },
    meta: { count: page.length, sort, order, filtered: Boolean(q || kind) },
  });

  return apiSuccess({
    documents: page.map((doc) =>
      serialiseDocument(doc, {
        factCount: doc._count.facts,
        pendingCount: doc.facts.length,
      }),
    ),
    nextCursor,
  });
});
