# HealthLog API Spec

`openapi.yaml` is the canonical OpenAPI 3.1 description for the HealthLog
Next.js API. It is the source of truth for the native iOS client's
DTO codegen.

## Preview locally

Open an interactive Redoc preview in your browser:

```bash
npx @redocly/cli preview docs/api/openapi.yaml
```

Generate static HTML for sharing:

```bash
npx @redocly/cli build-docs docs/api/openapi.yaml --output docs/api/index.html
```

## Validate

```bash
npx @redocly/cli lint docs/api/openapi.yaml
```

The spec is expected to be lint-clean (errors = 0). Some warnings are
intentional:

- `no-server-example.com` — `http://localhost:3000` is the dev server.
- `operation-2xx-response` / `operation-4xx-response` — webhook + redirect
  endpoints intentionally omit one or the other.
- `no-unused-components` — `ReminderPhase` is exposed for client codegen
  even though no path response references it directly.

## Layout

- **`info`** — title, version (mirrored from `package.json`), description.
- **`servers`** — production `https://healthlog.bombeck.io` plus
  `http://localhost:3000` for local development.
- **`tags`** — domain groupings (`Auth`, `Measurements`, `Medications`,
  `Mood`, `Dashboard`, `Insights`, `Achievements`, `DoctorReport`,
  `Integrations`, `User`, `Tokens`, `Notifications`, `Onboarding`,
  `Health`, `Settings`, `Analytics`, `Export`, `AuditLog`,
  `Monitoring`, `Webhooks`, `Ingest`, `Admin`).
- **`securitySchemes`**:
  - `bearerAuth` — long-lived `hlk_*` API tokens issued via `POST /api/tokens`.
    Required on `/api/ingest/medication`.
  - `sessionCookie` — HttpOnly `healthlog_session` cookie set by the
    password and passkey login flows. Used by the web app and any iOS
    client running inside a web view.
- **`components.schemas`** — DTOs for all routes plus the underlying
  Prisma models (e.g. `Measurement`, `Medication`, `MedicationIntakeEvent`,
  `MoodEntry`, `User`, `DashboardLayout`, `ApiEnvelope`, `ApiError`).
- **`paths`** — all routes from `src/app/api/**/route.ts`, including
  the `/api/admin/*` family which is tagged `Admin` and marked internal.

## Conventions

- Successful responses use the envelope `{ data, error: null }`.
- Error responses use the envelope `{ data: null, error: '<message>' }`.
- Pagination uses `limit` + `offset` query parameters and a
  `meta: { total, limit, offset }` block on the response.
- All timestamps are ISO 8601 / RFC 3339 (`format: date-time`) in UTC.
- IDs are CUIDs (opaque strings).

## Updating the spec

When adding or changing routes:

1. Update the relevant route handler under `src/app/api/**/route.ts`.
2. Mirror the change in `openapi.yaml`. Keep `operationId` camelCase and
   stable — the iOS codegen keys off it.
3. Run `npx @redocly/cli lint docs/api/openapi.yaml` and resolve all
   errors. Warnings are tolerated when documented above.
4. Bump `info.version` if the change is breaking for clients.
