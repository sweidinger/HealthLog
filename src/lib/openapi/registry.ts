/**
 * OpenAPI 3.1 base registry (v1.4.23 / Wave 4 F5a).
 *
 * Per the W1 stream-3 decision: `zod-openapi` (samchungy) reads Zod v4's
 * native `.meta()` metadata, so we annotate schemas in their original
 * validation files and register the route table here. The committed
 * spec at `docs/api/openapi.yaml` is regenerated via
 * `pnpm openapi:generate`; the CI gate in `.github/workflows/security.yml`
 * runs `pnpm openapi:check` to detect drift.
 *
 * The v1.4.23 baseline covers the 6-8 routes the v1.5 iOS app touches
 * (auth/login, auth/passkey/login-verify, auth/refresh, measurements
 * GET + POST + batch, devices POST, insights/comprehensive). Future
 * waves expand coverage organically as routes are touched. Once the
 * registry catches the rest of the hand-maintained spec, the CI gate
 * flips from `continue-on-error: true` to hard-fail.
 *
 * The registry is intentionally split:
 *   - `openApiBase` carries the static document scaffolding (info,
 *     servers, tags).
 *   - `buildOpenApiDocument` assembles the full spec by importing the
 *     registered route table from `./routes`. Routes live in their own
 *     file so additions don't touch the base.
 */
import { createDocument, type ZodOpenApiObject } from "zod-openapi";

export const openApiBase: Pick<
  ZodOpenApiObject,
  "openapi" | "info" | "servers" | "tags"
> = {
  openapi: "3.1.0",
  info: {
    title: "HealthLog API",
    version: "1.4.23",
    description:
      "Self-hosted personal-health-tracking PWA — public API surface for the iOS native client and external ingest.",
    license: {
      name: "AGPL-3.0",
      url: "https://github.com/MBombeck/HealthLog/blob/main/LICENSE",
    },
    contact: { name: "HealthLog", url: "https://healthlog.dev" },
  },
  servers: [
    { url: "https://healthlog.bombeck.io", description: "Production" },
    { url: "http://localhost:3000", description: "Local dev" },
  ],
  tags: [
    { name: "Auth" },
    { name: "Measurements" },
    { name: "Medications" },
    { name: "Mood" },
    { name: "Insights" },
    { name: "Notifications" },
    { name: "Devices" },
    { name: "Admin" },
  ],
};

/**
 * Assemble the full OpenAPI 3.1 document. Imports the route table
 * lazily so the base scaffolding stays usable from contexts that
 * shouldn't pull every Zod schema in the project (e.g. a hypothetical
 * future devtools-only consumer).
 */
export function buildOpenApiDocument(): ReturnType<typeof createDocument> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { openApiPaths, openApiComponents } = require("./routes") as {
    openApiPaths: ZodOpenApiObject["paths"];
    openApiComponents: ZodOpenApiObject["components"];
  };
  return createDocument({
    ...openApiBase,
    paths: openApiPaths,
    components: openApiComponents,
  });
}
