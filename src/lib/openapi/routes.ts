/**
 * OpenAPI route table — populated incrementally per W4 F5b and beyond.
 *
 * Routes are registered as `paths[<url>][<method>] = ZodOpenApiOperationObject`.
 * Schemas exported from `src/lib/validations/*` carry their own
 * `.meta({ id, title, description })` annotations so they show up in
 * `components.schemas` automatically when referenced via `ref:` or
 * direct schema inclusion.
 *
 * The registry intentionally starts at zero coverage. Commit 2 of the
 * v1.4.23 W4 batch wires the iOS-touched routes; later waves expand
 * coverage organically. The CI gate at
 * `.github/workflows/security.yml` runs in `continue-on-error: true`
 * mode while coverage grows.
 */
import type { ZodOpenApiObject } from "zod-openapi";

export const openApiPaths: NonNullable<ZodOpenApiObject["paths"]> = {};

export const openApiComponents: NonNullable<ZodOpenApiObject["components"]> = {
  schemas: {},
};
