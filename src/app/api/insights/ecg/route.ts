/**
 * v1.28.50 — ECG recording list route (metadata only, no waveform).
 *
 * `GET /api/insights/ecg` returns the authenticated user's ECG recordings
 * as a cheap, index-covered metadata list — recorded time, duration,
 * sampling rate, sample count, average heart rate, lead, and the DEVICE's
 * own rhythm classification. It NEVER decrypts or returns the waveform;
 * the per-recording strip is fetched on demand via
 * `GET /api/insights/ecg/[id]`.
 *
 * Regulatory framing (load-bearing): this surface reflects ONLY the
 * classification RESULT the recording device's certified on-device
 * algorithm produced. HealthLog never re-classifies an ECG, never reads
 * the waveform to form a verdict, and never produces a diagnosis. The
 * `classification` field the client renders is the device's, verbatim.
 *
 * Data-availability-gated by construction: an account with no recordings
 * gets `{ recordings: [], hasRecordings: false }`, and the client un-mounts
 * the whole surface rather than painting an empty card.
 *
 * Mirrors the `rhythm-events` route gating exactly: `apiHandler` wrapper,
 * cookie OR Bearer auth, `userId` narrowed from the session (never a query
 * field), the `insights` module gate, and the `insightStatus`
 * assistant-surface gate. No AI provider call — this is a pure DB read.
 */
import { apiSuccess } from "@/lib/api-response";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { requireAssistantSurface } from "@/lib/feature-flags";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

// Defensive cap. A ScanWatch user records a handful to a few dozen strips
// over time; this is a bound, not an expected ceiling.
const MAX_RECORDINGS = 200;

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  const m = await requireModuleEnabled(user.id, "insights");
  if (!m.enabled) return m.response;
  await requireAssistantSurface("insightStatus");

  const rows = await prisma.ecgRecording.findMany({
    where: { userId: user.id },
    // Everything EXCEPT `waveformEncrypted` — the list never touches the
    // encrypted blob, so no decrypt happens on this path.
    select: {
      id: true,
      recordedAt: true,
      durationSeconds: true,
      samplingFrequency: true,
      sampleCount: true,
      averageHeartRate: true,
      lead: true,
      rhythmClassification: true,
      source: true,
    },
    orderBy: { recordedAt: "desc" },
    take: MAX_RECORDINGS,
  });

  const recordings = rows.map((r) => ({
    id: r.id,
    recordedAt: r.recordedAt.toISOString(),
    durationSeconds: r.durationSeconds,
    samplingFrequency: r.samplingFrequency,
    sampleCount: r.sampleCount,
    averageHeartRate: r.averageHeartRate,
    lead: r.lead,
    classification: r.rhythmClassification,
    source: r.source,
    // A `ts-` fallback event carries a verdict but no signal to fetch.
    hasWaveform: r.sampleCount > 0,
  }));

  annotate({
    action: { name: "insights.ecg.list" },
    meta: { count: recordings.length },
  });

  return apiSuccess({
    recordings,
    hasRecordings: recordings.length > 0,
  });
});
