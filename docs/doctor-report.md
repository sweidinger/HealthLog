# Doctor Report

The doctor report is a printable PDF summary of a user's tracked vitals,
medication compliance, glucose context, and mood over a configurable window
(default 90 days, max 365). It is intended as discussion material for a
doctor's appointment, **not** a medical diagnosis.

## Two endpoints

The same aggregation logic backs both endpoints — `collectDoctorReportData`
in `src/lib/doctor-report-data.ts` is the single source of truth — so the
JSON payload and the server-rendered PDF are guaranteed to be in sync.

### `POST /api/doctor-report` — JSON payload

Returns the aggregated `DoctorReportData` envelope. Used by the PWA's
client-side renderer (`src/lib/doctor-report-pdf.ts`, jsPDF + autotable).
Best on desktop browsers and on Android, where local generation keeps the
PDF off the wire and works offline (cached page).

- Auth: session required.
- Rate-limit: 10/h per user.
- Body: `{ days?: number }` (default 90).
- Response: `200 application/json` with envelope `{ data, error: null }`.
- Audit action: `doctor-report.generate`.

### `POST /api/doctor-report/pdf` — server-rendered PDF

Returns the ready-to-download PDF bytes. Used primarily on iOS/Safari, where
the client-side jsPDF download UX is unreliable (Safari sometimes opens the
PDF in a new tab without preserving the filename or fails the blob save).

- Auth: session required (`401` otherwise).
- Rate-limit: 10/h per user, shared with the JSON endpoint (`429` on excess).
- Body: `{ days?: number; locale?: "de" | "en" }`. Body is optional — empty
  bodies are accepted.
- Locale resolution: explicit `body.locale` wins, then the
  `Accept-Language` header (`de*` → `de`, anything else → `en`), then the
  hard fallback `de`.
- Response: `200 application/pdf` with
  `Content-Disposition: attachment; filename="healthlog-report-YYYY-MM-DD.pdf"`
  and `Cache-Control: no-store`. Body is the raw PDF bytes.
- Errors: JSON envelope `{ data: null, error: "..." }` for `401` and `429`;
  `500` if rendering fails.
- Audit action: `doctor-report.pdf.generate`.

## Implementation notes

- `src/lib/doctor-report-pdf-core.ts` contains the isomorphic renderer.
  jsPDF runs unchanged in Node — `doc.output("arraybuffer")` returns a valid
  `%PDF-` byte stream in both environments, so we deliberately avoid headless
  Chromium (Puppeteer/Playwright) to keep the runtime dependency surface low.
- `src/lib/doctor-report-pdf.ts` is a thin client façade that returns the
  raw `jsPDF` instance so the existing settings-page download flow (which
  calls `doc.save(...)`) keeps working unchanged.
- Server-side translations come from `messages/{de,en}.json` via
  `getServerTranslator()` (`src/lib/i18n/server-translator.ts`).
