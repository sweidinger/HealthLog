/**
 * v1.18.9 — vision-capability resolution for the Lab-OCR ingestion path.
 *
 * The provider abstraction is text-only by default; only some providers +
 * models can read an uploaded photo / PDF. This module is the single source of
 * truth for "can the user's configured provider read images?", so the upload
 * route and the capability probe endpoint agree.
 *
 * Capability is a function of (providerType, model), evaluated against the
 * documented vision allowlists below. It is PURE and presence-only — it never
 * decrypts a key, constructs a client, or probes liveness. A `true` here can
 * still resolve to a dead provider at call time (revoked key, unreachable
 * local host); the route surfaces that as an extract failure.
 */

/**
 * Anthropic vision models. The Messages API `image` + `document` blocks are
 * accepted by the Claude 3.5+ / 3.7 / 4 families. An older `claude-2*` /
 * `claude-instant*` pin is text-only.
 */
function anthropicSupportsVision(model: string): boolean {
  const m = model.toLowerCase();
  return (
    m.startsWith("claude-3-5") ||
    m.startsWith("claude-3.5") ||
    m.startsWith("claude-3-7") ||
    m.startsWith("claude-3.7") ||
    m.startsWith("claude-sonnet-4") ||
    m.startsWith("claude-opus-4") ||
    m.startsWith("claude-haiku-4")
  );
}

/**
 * OpenAI vision models (also covers the operator's admin key + Codex when it
 * runs an OpenAI model — though Codex is excluded by `providerType`). `gpt-4o`,
 * `gpt-4.1`, `gpt-4-turbo`, and the `o*` reasoning models read image content;
 * `gpt-3.5*` and the legacy `gpt-4` (non-turbo) 400 on an image block.
 */
function openaiSupportsVision(model: string): boolean {
  const m = model.toLowerCase();
  return (
    m.startsWith("gpt-4o") ||
    m.startsWith("gpt-4.1") ||
    m.startsWith("gpt-4-turbo") ||
    m.startsWith("o1") ||
    m.startsWith("o3") ||
    m.startsWith("o4")
  );
}

/**
 * Logical provider tags the OCR path reasons about. Mirrors the
 * `ProviderChainType` vocabulary plus the legacy `admin-key` single-provider
 * tag `resolveProvider`'s admin fallback returns.
 */
export type VisionProviderType =
  | "anthropic"
  | "openai"
  | "admin-openai"
  | "admin-key"
  | "local"
  | "codex"
  | "none";

/**
 * Pure capability check over a (providerType, model) pair.
 *
 *  - anthropic            → vision when the model is a 3.5+/4 family pin.
 *  - openai / admin-*     → vision when the model is a gpt-4o/4.1/turbo/o* pin.
 *  - local                → trust-by-default true: the operator opted in by
 *                           configuring a self-hosted model and we cannot sniff
 *                           its capabilities; a non-vision local model surfaces
 *                           a clear extract failure rather than a silent gate.
 *  - codex / none         → false (no vision over the Codex wire; nothing
 *                           configured).
 */
export function supportsVisionForConfig(
  providerType: VisionProviderType,
  model: string | null,
): boolean {
  switch (providerType) {
    case "anthropic":
      return model ? anthropicSupportsVision(model) : false;
    case "openai":
    case "admin-openai":
    case "admin-key":
      return model ? openaiSupportsVision(model) : false;
    case "local":
      return true;
    case "codex":
    case "none":
    default:
      return false;
  }
}

/**
 * Whether PDFs are supported for a given provider. Only Anthropic accepts a
 * native `document` block over the Messages API; OpenAI / local read images
 * only (a server-side rasterizer is a deferred follow-up). The route uses this
 * to reject a PDF upload with a clear "use a photo / configure Claude" message
 * on a non-Anthropic provider.
 */
export function supportsPdfForProvider(
  providerType: VisionProviderType,
): boolean {
  return providerType === "anthropic";
}
