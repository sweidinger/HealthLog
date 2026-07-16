import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

/**
 * v1.28.50 — `<EcgSection>` / `<EcgDetail>` unit tests.
 *
 * The load-bearing behaviour under test:
 *   - data-availability gating: the section un-mounts entirely when the
 *     user has no recordings or while the payload is in flight;
 *   - the NON-DIAGNOSTIC framing (mirrors `RhythmEventsCard`): the device's
 *     result is shown attributed to the device, a permanent disclaimer
 *     states HealthLog does not interpret / diagnose, and any non-normal
 *     device result adds the "discuss with a clinician" note — while a
 *     normal result does NOT.
 *
 * `useAuth` + TanStack Query are mocked and the assertions run through SSR
 * (the suite's node environment has no DOM), exactly like the sibling
 * `rhythm-events-card` test.
 */

vi.mock("@/hooks/use-auth", () => ({
  useAuth: vi.fn(() => ({ isAuthenticated: true, user: null })),
}));

const useQueryMock = vi.fn();
vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: unknown) => useQueryMock(opts),
}));

const { EcgSection, EcgDetail } = await import("../ecg-section");

interface EcgRecordingListItem {
  id: string;
  recordedAt: string;
  durationSeconds: number | null;
  samplingFrequency: number;
  sampleCount: number;
  averageHeartRate: number | null;
  lead: string | null;
  classification: "IRREGULAR" | "NOT_DETECTED" | "INCONCLUSIVE" | null;
  source: string;
  hasWaveform: boolean;
}

const IRREGULAR_REC: EcgRecordingListItem = {
  id: "ecg_1",
  recordedAt: "2026-06-01T09:15:00.000Z",
  durationSeconds: 30,
  samplingFrequency: 300,
  sampleCount: 9000,
  averageHeartRate: 72,
  lead: null,
  classification: "IRREGULAR",
  source: "WITHINGS",
  hasWaveform: true,
};

const NORMAL_REC: EcgRecordingListItem = {
  ...IRREGULAR_REC,
  id: "ecg_2",
  classification: "NOT_DETECTED",
};

const DETAIL = {
  recordedAt: "2026-06-01T09:15:00.000Z",
  durationSeconds: 30,
  samplingFrequency: 300,
  averageHeartRate: 72,
  lead: null,
  classification: "IRREGULAR" as const,
  source: "WITHINGS",
  samples: [0, 10, -5, 40, -20, 5, 0],
  decimated: true,
};

function renderSection(
  data:
    { recordings: EcgRecordingListItem[]; hasRecordings: boolean } | undefined,
) {
  useQueryMock.mockReturnValue({ data, isLoading: false });
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <EcgSection />
    </I18nProvider>,
  );
}

function renderDetail(
  recording: EcgRecordingListItem,
  resultLabel: string | null,
) {
  useQueryMock.mockReturnValue({ data: DETAIL, isLoading: false });
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <EcgDetail
        recording={recording}
        resultLabel={resultLabel}
        onBack={() => {}}
      />
    </I18nProvider>,
  );
}

describe("<EcgSection>", () => {
  it("renders nothing before the payload resolves", () => {
    useQueryMock.mockReturnValue({ data: undefined, isLoading: true });
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <EcgSection />
      </I18nProvider>,
    );
    expect(html).toBe("");
  });

  it("renders nothing when the user has no recordings (data-availability gate)", () => {
    const html = renderSection({ recordings: [], hasRecordings: false });
    expect(html).toBe("");
  });

  it("renders the recording list with a device-result label per row", () => {
    const html = renderSection({
      recordings: [IRREGULAR_REC, NORMAL_REC],
      hasRecordings: true,
    });
    expect(html).toContain('data-slot="ecg-card"');
    expect(html).toContain('data-slot="ecg-list"');
    const rows = (html.match(/data-slot="ecg-row"/g) ?? []).length;
    expect(rows).toBe(2);
    expect(html).toContain("Atrial fibrillation detected");
    expect(html).toContain("No signs of atrial fibrillation");
  });

  it("shows the permanent non-diagnostic disclaimer on the list", () => {
    const html = renderSection({
      recordings: [IRREGULAR_REC],
      hasRecordings: true,
    });
    expect(html).toContain('data-slot="ecg-disclaimer"');
    expect(html).toContain(
      "HealthLog does not read or interpret ECG recordings",
    );
    expect(html).toContain("does not provide a diagnosis");
  });
});

describe("<EcgDetail> — non-diagnostic framing", () => {
  it("attributes the result to the recording device and draws the waveform", () => {
    const html = renderDetail(IRREGULAR_REC, "Atrial fibrillation detected");
    expect(html).toContain('data-slot="ecg-detail"');
    expect(html).toContain('data-slot="ecg-result"');
    // Load-bearing: the verdict is the device's, attributed to the device.
    expect(html).toContain("as reported by the recording device");
    expect(html).toContain("Atrial fibrillation detected");
    // The waveform strip is rendered.
    expect(html).toContain('data-slot="ecg-trace"');
    // And the permanent disclaimer is present here too.
    expect(html).toContain('data-slot="ecg-disclaimer"');
  });

  it("adds the 'discuss with a clinician' note on a non-normal result", () => {
    const html = renderDetail(IRREGULAR_REC, "Atrial fibrillation detected");
    expect(html).toContain('data-slot="ecg-clinician-note"');
    expect(html).toContain("discuss this recording with a clinician");
  });

  it("adds the clinician note for an INCONCLUSIVE result", () => {
    const html = renderDetail(
      { ...IRREGULAR_REC, classification: "INCONCLUSIVE" },
      "Inconclusive recording",
    );
    expect(html).toContain('data-slot="ecg-clinician-note"');
  });

  it("does NOT add the clinician note for a normal (not-detected) result", () => {
    const html = renderDetail(NORMAL_REC, "No signs of atrial fibrillation");
    expect(html).not.toContain('data-slot="ecg-clinician-note"');
    // But the disclaimer + device attribution are still present.
    expect(html).toContain('data-slot="ecg-disclaimer"');
    expect(html).toContain("as reported by the recording device");
  });
});
