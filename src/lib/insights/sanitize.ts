/**
 * Sanitize user-provided strings before embedding them in LLM prompts.
 * Strips control characters, prompt-injection patterns, and limits length.
 *
 * v1.30.25 — control characters are replaced with a SPACE, not deleted, and
 * the run is collapsed before the injection patterns are applied.
 *
 * Deleting them was self-defeating: every injection pattern below is anchored
 * on a `\b` word boundary, and deletion WELDS the neighbouring tokens
 * together. `"Ferritin\nSYSTEM: …"` collapsed to `"FerritinSYSTEM: …"`, where
 * `\bsystem\s*:` no longer matches — so the payload survived precisely
 * BECAUSE it was preceded by a newline, which is the most natural way to
 * write it. Substituting a space preserves the boundary the patterns need.
 * Order is load-bearing: normalise whitespace first, then strip patterns.
 */
export function sanitizeForPrompt(input: string, maxLength = 100): string {
  return (
    input
      // Replace control characters with a space so adjacent tokens stay
      // separated (see the note above — deletion defeats the `\b` anchors).
      .replace(/[\x00-\x1f\x7f]/g, " ")
      // Collapse the runs the substitution just created.
      .replace(/\s+/g, " ")
      // Remove common prompt injection patterns
      .replace(/```/g, "")
      .replace(/\bsystem\s*:/gi, "")
      .replace(/\bassistant\s*:/gi, "")
      .replace(/\buser\s*:/gi, "")
      .replace(/\bignore\s+(previous|above|all)\b/gi, "")
      .replace(/\bforget\s+(previous|above|all)\b/gi, "")
      // Collapse again — pattern removal leaves gaps behind.
      .replace(/\s+/g, " ")
      // Limit length
      .slice(0, maxLength)
      .trim()
  );
}
