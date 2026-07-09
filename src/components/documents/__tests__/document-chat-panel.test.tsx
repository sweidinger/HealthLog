import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import {
  DocumentChatConversation,
  documentChatErrorKey,
} from "../document-chat-panel";
import type { DocumentChatMessage } from "../use-document-chat";

/**
 * The scoped "chat about this document" surface:
 *   - the OPEN conversation body renders a plain-text message log + composer +
 *     an always-on safety note; assistant/user prose is XSS-safe React text
 *     (raw HTML in a turn is escaped, never injected);
 *   - error codes map to calm translation keys, never a raw provider string.
 *
 * The stateful container + indexing gate live in `document-chat-drawer.tsx`
 * (Coach-drawer chrome scoped to one document); its open/not-indexed branches
 * ride the Radix Sheet portal, so they are pinned by the e2e suite rather than
 * a static render here.
 */

function renderPure(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

const noop = () => {};

function conversation(
  overrides: Partial<
    React.ComponentProps<typeof DocumentChatConversation>
  > = {},
) {
  const props: React.ComponentProps<typeof DocumentChatConversation> = {
    messages: [],
    optimisticContent: null,
    streamingContent: "",
    isStreaming: false,
    streamErrorKey: null,
    historyPending: false,
    historyError: false,
    draft: "",
    onDraftChange: noop,
    onSubmit: noop,
    onClose: noop,
    ...overrides,
  };
  return <DocumentChatConversation {...props} />;
}

const messages: DocumentChatMessage[] = [
  {
    id: "u1",
    role: "user",
    content: "What does the Impression say?",
    createdAt: "2026-07-07T10:00:00.000Z",
  },
  {
    id: "a1",
    role: "assistant",
    content: "Per the report's Impression, the findings are unremarkable.",
    createdAt: "2026-07-07T10:00:02.000Z",
  },
];

describe("<DocumentChatConversation> (open body)", () => {
  it("renders the composer + always-on safety note", () => {
    const html = renderPure(conversation());
    expect(html).toContain('data-slot="document-chat"');
    expect(html).toContain('data-state="open"');
    expect(html).toContain('data-slot="document-chat-input"');
    expect(html).toContain('data-slot="document-chat-send"');
    // Safety-visible copy: describes the document, not medical advice.
    expect(html).toContain('data-slot="document-chat-safety"');
    expect(html).toContain("not medical advice");
  });

  it("shows the empty prompt before any turn", () => {
    const html = renderPure(conversation());
    expect(html).toContain('data-slot="document-chat-empty"');
  });

  it("renders a user + assistant turn, and the assistant text plainly", () => {
    const html = renderPure(conversation({ messages }));
    expect(html).toContain('data-role="user"');
    expect(html).toContain('data-role="assistant"');
    expect(html).toContain("What does the Impression say?");
    // A citation-style phrase is just text.
    expect(html).toContain("Per the report&#x27;s Impression");
    // No empty prompt once turns exist.
    expect(html).not.toContain('data-slot="document-chat-empty"');
  });

  it("renders assistant prose as XSS-safe text — raw HTML is escaped", () => {
    const html = renderPure(
      conversation({
        messages: [
          {
            id: "a2",
            role: "assistant",
            content: "<img src=x onerror=alert(1)> the value is normal.",
            createdAt: "2026-07-07T10:00:00.000Z",
          },
        ],
      }),
    );
    // The markup is escaped, never injected as a live element.
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("shows the streaming assistant tail once tokens arrive", () => {
    const html = renderPure(
      conversation({
        streamingContent: "Reading the values",
        isStreaming: true,
      }),
    );
    // The live tail streams word-by-word (each token in its own span), so
    // assert the words are present rather than a contiguous run.
    expect(html).toContain("Reading");
    expect(html).toContain("values");
    // The thinking placeholder is gone once content streams.
    expect(html).not.toContain('data-slot="document-chat-thinking"');
  });

  it("shows the thinking placeholder while streaming with no tokens yet", () => {
    const html = renderPure(
      conversation({ streamingContent: "", isStreaming: true }),
    );
    expect(html).toContain('data-slot="document-chat-thinking"');
  });

  it("surfaces a mapped error key, never a raw provider string", () => {
    const html = renderPure(
      conversation({ streamErrorKey: "documents.chat.errorRateLimited" }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Too many messages");
  });
});

describe("documentChatErrorKey", () => {
  it("maps provider + client codes to calm keys, defaulting to generic", () => {
    expect(documentChatErrorKey("documents.chat.budget.exceeded")).toBe(
      "documents.chat.errorBudget",
    );
    expect(documentChatErrorKey("documents.inbound.rateLimited")).toBe(
      "documents.chat.errorRateLimited",
    );
    expect(documentChatErrorKey("consent.ai.required")).toBe(
      "documents.chat.errorConsent",
    );
    expect(documentChatErrorKey("something.unknown")).toBe(
      "documents.chat.errorGeneric",
    );
    expect(documentChatErrorKey(null)).toBe("documents.chat.errorGeneric");
  });
});
