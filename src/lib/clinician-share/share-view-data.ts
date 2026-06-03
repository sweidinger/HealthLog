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
import {
  collectDoctorReportData,
  type DoctorReportData,
  type DoctorReportRange,
} from "@/lib/doctor-report-data";
import { parseDoctorReportPrefs } from "@/lib/validations/doctor-report-prefs";
import type { ShareContext } from "@/lib/clinician-share/resolve-share-token";

export interface ShareViewData {
  /** The aggregated, owner-scoped report payload over the frozen window. */
  report: DoctorReportData;
  /** The resolved section toggles (mood opt-in, defaults otherwise). */
  sections: ReturnType<typeof parseDoctorReportPrefs>;
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

  const report = await collectDoctorReportData(context.ownerUserId, range, {
    sections,
  });

  return { report, sections };
}
