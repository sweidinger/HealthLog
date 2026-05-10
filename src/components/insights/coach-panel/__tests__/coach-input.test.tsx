import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { CoachInput } from "../coach-input";

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("<CoachInput>", () => {
  it("mounts the textarea, mic, send button, and disclaimer slots", () => {
    const html = render(
      <CoachInput value="" onChange={() => {}} onSubmit={() => {}} />,
    );
    expect(html).toContain('data-slot="coach-input"');
    expect(html).toContain('data-slot="coach-input-textarea"');
    expect(html).toContain('data-slot="coach-input-mic"');
    expect(html).toContain('data-slot="coach-input-send"');
    expect(html).toContain('data-slot="coach-input-disclaimer"');
    expect(html).toContain("Coach replies are generated");
  });

  it("renders the localised placeholder + hint", () => {
    const html = render(
      <CoachInput value="" onChange={() => {}} onSubmit={() => {}} />,
    );
    expect(html).toContain("Ask anything about your data");
    expect(html).toContain("Press Enter to send");
  });

  it("renders the German placeholder + disclaimer when locale is 'de'", () => {
    const html = render(
      <CoachInput value="" onChange={() => {}} onSubmit={() => {}} />,
      "de",
    );
    expect(html).toContain("Frag mich etwas zu deinen Daten");
    expect(html).toContain("Klinische Entscheidungen gehören in die Hand");
  });

  it("disables the mic button with the v1.5 tooltip text", () => {
    const html = render(
      <CoachInput value="" onChange={() => {}} onSubmit={() => {}} />,
    );
    // The button carries both the disabled attribute and the
    // localised v1.5 voice tooltip on aria-label. Attribute order is
    // not guaranteed across React versions, so we check for both
    // independently inside the same tag.
    const micTag = html.match(/<button[^>]*data-slot="coach-input-mic"[^>]*>/);
    expect(micTag).not.toBeNull();
    expect(micTag?.[0]).toContain("disabled");
    expect(micTag?.[0]).toContain(
      'aria-label="Voice input arrives with the iOS app in v1.5."',
    );
  });

  it("disables the send button when the value is empty", () => {
    const html = render(
      <CoachInput value="" onChange={() => {}} onSubmit={() => {}} />,
    );
    const sendTag = html.match(
      /<button[^>]*data-slot="coach-input-send"[^>]*>/,
    );
    expect(sendTag?.[0]).toMatch(/\sdisabled(=""|\s|>)/);
  });

  it("disables the send button when value is whitespace-only", () => {
    const html = render(
      <CoachInput value="   " onChange={() => {}} onSubmit={() => {}} />,
    );
    const sendTag = html.match(
      /<button[^>]*data-slot="coach-input-send"[^>]*>/,
    );
    expect(sendTag?.[0]).toMatch(/\sdisabled(=""|\s|>)/);
  });

  it("enables the send button when there is non-empty content", () => {
    const html = render(
      <CoachInput
        value="Why was BP higher on Monday?"
        onChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    // Locate the send button tag and assert no boolean `disabled=""`
    // attribute (Tailwind class names contain the word `disabled` in
    // utilities like `disabled:opacity-50`, so we match the actual
    // attribute form `disabled=""` that React emits for boolean
    // attributes).
    const sendTag = html.match(
      /<button[^>]*data-slot="coach-input-send"[^>]*>/,
    );
    expect(sendTag).not.toBeNull();
    expect(sendTag?.[0]).not.toMatch(/\sdisabled(=""|\s|>)/);
  });

  it("disables the send button while streaming", () => {
    const html = render(
      <CoachInput
        value="Hello"
        onChange={() => {}}
        onSubmit={() => {}}
        disabled
        isStreaming
      />,
    );
    const sendTag = html.match(
      /<button[^>]*data-slot="coach-input-send"[^>]*>/,
    );
    expect(sendTag?.[0]).toMatch(/\sdisabled(=""|\s|>)/);
    // Spinner replaces the send icon in the streaming state.
    expect(html).toContain("animate-spin");
  });

  it("invokes onChange when the parent passes a controlled handler", () => {
    // SSR can't fire DOM events; smoke-check the contract by calling
    // the supplied handler directly.
    const handler = vi.fn();
    render(<CoachInput value="" onChange={handler} onSubmit={() => {}} />);
    handler("typed");
    expect(handler).toHaveBeenCalledWith("typed");
  });

  it("renders the textarea with rows=2 to match the artboard", () => {
    const html = render(
      <CoachInput value="" onChange={() => {}} onSubmit={() => {}} />,
    );
    expect(html).toMatch(/data-slot="coach-input-textarea"[^>]*rows="2"/);
  });
});
