import { describe, expect, it } from "vitest";
import {
  parseSummaryFromContent,
  stripJsonFences,
} from "@/lib/insights/status-shared";

/**
 * The Anthropic + local providers have no native JSON mode, so a compliant
 * model still routinely wraps its `{ "summary": … }` reply in a ```json
 * fence or prefixes it with a sentence. These guards pin the fence-strip
 * fallback so such replies parse instead of surfacing the raw fenced string
 * as the user-facing assessment.
 */

describe("stripJsonFences", () => {
  it("strips a ```json fence", () => {
    const out = stripJsonFences('```json\n{"summary":"ok"}\n```');
    expect(out).toBe('{"summary":"ok"}');
  });

  it("strips a bare ``` fence", () => {
    const out = stripJsonFences('```\n{"summary":"ok"}\n```');
    expect(out).toBe('{"summary":"ok"}');
  });

  it("narrows to the first { … last } when prose surrounds the object", () => {
    const out = stripJsonFences('Here is the result: {"summary":"ok"} done.');
    expect(out).toBe('{"summary":"ok"}');
  });

  it("is a no-op on already-clean JSON", () => {
    expect(stripJsonFences('{"summary":"ok"}')).toBe('{"summary":"ok"}');
  });

  it("returns the trimmed input when there is no object body", () => {
    expect(stripJsonFences("  plain prose  ")).toBe("plain prose");
  });
});

describe("parseSummaryFromContent", () => {
  it("parses a clean JSON envelope", () => {
    expect(parseSummaryFromContent('{"summary":"hello"}')).toBe("hello");
  });

  it("parses a ```json-fenced envelope (no native JSON mode)", () => {
    expect(parseSummaryFromContent('```json\n{"summary":"hello"}\n```')).toBe(
      "hello",
    );
  });

  it("parses a sentence-prefixed envelope", () => {
    expect(parseSummaryFromContent('Sure:\n{"summary":"hello"} — done')).toBe(
      "hello",
    );
  });

  it("falls back to the raw content for bare prose", () => {
    expect(parseSummaryFromContent("just prose, no json")).toBe(
      "just prose, no json",
    );
  });
});
