/**
 * v1.11.0 — scoped data load for the public clinician view (Epic C, C5).
 *
 * Given a {@link ShareContext} (already proven by {@link resolveShareToken}),
 * aggregate exactly the data the owner froze into the link: the doctor-report
 * payload over the frozen `[rangeStart, rangeEnd]` window with the frozen
 * section toggles. The owner `userId` comes ONLY from the share context — never
 * from a session, never from the wire.
 *
 * KVNR is DEFAULT OFF: the clinician view never decrypts or surfaces the
 * insurance number. The descriptive wellness scores are kept (the view fences
 * them under an explicit "not a clinical assessment" card), but they are read
 * straight from the aggregator — no AI call, no coach, no insight generation.
 */
import { prisma } from "@/lib/db";
import {
  collectDoctorReportData,
  type DoctorReportData,
  type DoctorReportRange,
} from "@/lib/doctor-report-data";
import { servingClassFor } from "@/lib/documents/upload-policy";
import type { DocumentServingClass } from "@/lib/documents/upload-policy";
import {
  hasAnyReportSection,
  parseDoctorReportPrefs,
} from "@/lib/validations/doctor-report-prefs";
import type { ShareContext } from "@/lib/clinician-share/resolve-share-token";

/**
 * v1.28 — metadata for one document on the share's frozen set. NEVER carries
 * bytes: the share serve route (`/c/<token>/d/<id>`) is the only decrypt path
 * (P3-D5). The recipient view renders this list and points each entry at that
 * route (Class A inline preview / Class B download).
 */
export interface ShareViewDocument {
  id: string;
  title: string | null;
  kind: string;
  /** Filing date (YYYY-MM-DD at UTC) or null. */
  documentDate: string | null;
  byteSize: number;
  /**
   * The stored content type (metadata, never bytes). The recipient view uses
   * it to pick the inline surface — an image tag for `image/*`, a framed PDF
   * for `application/pdf` — within the Class A carve-out. Class B types are
   * download-only regardless.
   */
  mimeType: string;
  servingClass: DocumentServingClass;
}

export interface ShareViewData {
  /**
   * The aggregated, owner-scoped report payload over the frozen window, or
   * `null` for a documents-only share. `null` is the load-bearing privacy
   * state: the aggregator is NEVER called, so no health data leaves the DB —
   * the recipient sees only the attached documents.
   */
  report: DoctorReportData | null;
  /** The resolved section toggles (mood opt-in, defaults otherwise). */
  sections: ReturnType<typeof parseDoctorReportPrefs>;
  /** v1.28 — the hand-picked documents on this link (metadata only). */
  documents: ShareViewDocument[];
  /**
   * v1.28.13 — whether this link carries ONLY documents (no report section
   * enabled). The public view reads it to render a documents-only surface with
   * no health-record chrome.
   */
  documentOnly: boolean;
}

/**
 * Resolve the frozen reporting window from the share context. `rangeEnd` null
 * means "rolling up to now"; the start is always the absolute instant the
 * owner froze, so a rolling share can never reach data older than chosen.
 */
function frozenRange(context: ShareContext): DoctorReportRange {
  const start = context.rangeStart;
  const end = context.rangeEnd ?? new Date();
  const spanDays = Math.max(
    1,
    Math.ceil((end.getTime() - start.getTime()) / 86_400_000),
  );
  return { start, end, days: spanDays };
}

/**
 * Load the scoped read-only view for a resolved share token. Pure data
 * assembly — no auth (the token was already proven), no rate-limit (the route
 * owns that), no session, no AI.
 */
export async function loadShareViewData(
  context: ShareContext,
): Promise<ShareViewData> {
  const sections = parseDoctorReportPrefs(context.sectionsJson);
  const range = frozenRange(context);

  // A share with NO report section enabled is a documents-only share: never
  // aggregate — no health metric is read from the DB, let alone served. This is
  // the load-bearing guarantee behind "share this document, not the record".
  const documentOnly = !hasAnyReportSection(sections);

  const [report, documents] = await Promise.all([
    documentOnly
      ? Promise.resolve(null)
      : collectDoctorReportData(context.ownerUserId, range, { sections }),
    loadShareDocuments(context),
  ]);

  return { report, sections, documents, documentOnly };
}

/**
 * The frozen document set for a resolved share, as metadata only. Scoped to
 * the link's membership rows AND the owner (defence in depth) AND live rows —
 * a document the owner soft-deleted after sharing drops out of the list, just
 * as it 404s at the serve route. The blob column is never selected.
 */
async function loadShareDocuments(
  context: ShareContext,
): Promise<ShareViewDocument[]> {
  const rows = await prisma.clinicianShareLinkDocument.findMany({
    where: {
      shareLinkId: context.shareLinkId,
      document: { userId: context.ownerUserId, deletedAt: null },
    },
    select: {
      document: {
        select: {
          id: true,
          title: true,
          kind: true,
          documentDate: true,
          byteSize: true,
          mimeType: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  return rows.map(({ document }) => ({
    id: document.id,
    title: document.title,
    kind: document.kind,
    documentDate: document.documentDate
      ? document.documentDate.toISOString().slice(0, 10)
      : null,
    byteSize: document.byteSize,
    mimeType: document.mimeType,
    servingClass: servingClassFor(document.mimeType),
  }));
}
