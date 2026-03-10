/**
 * Sanitize user-provided strings before embedding them in LLM prompts.
 * Strips control characters, prompt-injection patterns, and limits length.
 */
export function sanitizeForPrompt(input: string, maxLength = 100): string {
  return (
    input
      // Remove control characters
      .replace(/[\x00-\x1f\x7f]/g, "")
      // Remove common prompt injection patterns
      .replace(/```/g, "")
      .replace(/\bsystem\s*:/gi, "")
      .replace(/\bassistant\s*:/gi, "")
      .replace(/\buser\s*:/gi, "")
      .replace(/\bignore\s+(previous|above|all)\b/gi, "")
      .replace(/\bforget\s+(previous|above|all)\b/gi, "")
      // Limit length
      .slice(0, maxLength)
      .trim()
  );
}
