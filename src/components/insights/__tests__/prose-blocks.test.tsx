import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import {
  ProseBlocks,
  splitParagraphs,
} from "@/components/insights/prose-blocks";
import {
  StreamedProse,
  splitProseSegments,
} from "@/components/insights/coach-panel/streamed-prose";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

describe("splitParagraphs", () => {
  it("splits on blank lines and trims, dropping empties", () => {
    expect(splitParagraphs("one\n\ntwo")).toEqual(["one", "two"]);
    expect(splitParagraphs("  a  \n\n\n  b  ")).toEqual(["a", "b"]);
    expect(splitParagraphs("solo")).toEqual(["solo"]);
    expect(splitParagraphs("\n\n  \n\n")).toEqual([]);
  });

  it("keeps a single newline inside one paragraph", () => {
    expect(splitParagraphs("line1\nline2")).toEqual(["line1\nline2"]);
  });
});

describe("ProseBlocks", () => {
  it("renders blank-line-separated text as real <p> blocks", () => {
    const html = render(<ProseBlocks text={"First idea.\n\nSecond idea."} />);
    const paras = (html.match(/<p\b/g) ?? []).length;
    expect(paras).toBe(2);
    expect(html).toContain("First idea.");
    expect(html).toContain("Second idea.");
  });

  it("turns a single newline into a <br/>", () => {
    const html = render(<ProseBlocks text={"line a\nline b"} />);
    expect(html).toContain("<br/>");
    expect((html.match(/<p\b/g) ?? []).length).toBe(1);
  });

  it("strips stray chart tokens from the prose by default", () => {
    const html = render(
      <ProseBlocks text={"Your weight metric:WEIGHT held."} />,
    );
    expect(html).not.toContain("metric:WEIGHT");
    expect(html).toContain("Your weight");
  });

  it("linkifies a catalog-known /learn/<slug> reference as a safe anchor", () => {
    const html = render(
      <ProseBlocks
        text={"More on this: https://healthlog.dev/learn/resting-heart-rate"}
      />,
    );
    expect(html).toContain('data-slot="inline-learn-link"');
    expect(html).toContain("/learn/resting-heart-rate");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("leaves an unknown /learn slug as plain text (fail-closed)", () => {
    const html = render(
      <ProseBlocks text={"see https://healthlog.dev/learn/totally-made-up"} />,
    );
    expect(html).not.toContain('data-slot="inline-learn-link"');
    expect(html).toContain("/learn/totally-made-up");
  });

  it("does not strip or linkify when both are disabled (user text)", () => {
    const html = render(
      <ProseBlocks
        text={"keep metric:WEIGHT and /learn/resting-heart-rate verbatim"}
        strip={false}
        linkify={false}
      />,
    );
    expect(html).toContain("metric:WEIGHT");
    expect(html).not.toContain('data-slot="inline-learn-link"');
  });

  it("groups consecutive '- ' lines into a real <ul> and strips the markers", () => {
    const html = render(
      <ProseBlocks
        text={
          "Two options stand out:\n- walk after lunch\n- an earlier bedtime\n\nBoth are low effort."
        }
      />,
    );
    expect((html.match(/<ul\b/g) ?? []).length).toBe(1);
    expect((html.match(/<li\b/g) ?? []).length).toBe(2);
    expect(html).toContain("walk after lunch");
    expect(html).not.toContain("- walk");
    // The intro line and the trailing paragraph stay real <p> blocks.
    expect((html.match(/<p\b/g) ?? []).length).toBe(2);
  });

  it("renders a **bold** span as <strong> and leaves unclosed markers literal", () => {
    const html = render(
      <ProseBlocks
        text={"The **key takeaway** stands.\n\nA stray ** stays literal."}
      />,
    );
    expect(html).toContain("<strong>key takeaway</strong>");
    expect(html).toContain("A stray ** stays literal.");
  });
});

describe("StreamedProse", () => {
  it("settles to real paragraph blocks when not streaming", () => {
    const html = render(
      <StreamedProse
        content={"Where things stand.\n\nOne thing to try."}
        streaming={false}
      />,
    );
    expect((html.match(/<p\b/g) ?? []).length).toBe(2);
    expect(html).toContain("Where things stand.");
    expect(html).toContain("One thing to try.");
  });

  it("animates only the growing tail paragraph while streaming", () => {
    const html = render(
      <StreamedProse
        content={"Settled paragraph.\n\nGrowing tail words"}
        streaming
      />,
    );
    // The completed first paragraph settles as plain text (no spans).
    expect(html).toContain("Settled paragraph.");
    // The tail renders each word in its own fade-in span.
    for (const word of ["Growing ", "tail ", "words"]) {
      expect(html).toContain(`>${word}</span>`);
    }
  });

  it("does not leak a chart token into streamed prose", () => {
    const html = render(
      <StreamedProse content={"Trending up metric:WEIGHT"} streaming />,
    );
    expect(html).not.toContain("metric:WEIGHT");
  });
});

describe("splitProseSegments", () => {
  it("keeps each word with its trailing whitespace", () => {
    expect(splitProseSegments("a b c")).toEqual(["a ", "b ", "c"]);
    expect(splitProseSegments("")).toEqual([]);
  });
});
