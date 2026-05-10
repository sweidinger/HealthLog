import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/context";
import { RecommendationFeedback } from "../recommendation-feedback";

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: null, isLoading: false }),
  useMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
    error: null,
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "test-user", username: "tester", role: "USER" },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

const baseProps = {
  recId: "rec-1",
  recText: "Discuss home BP log with your physician.",
  recSeverity: "important" as const,
  metricSourceType: "bloodPressure",
  metricSourceTimeRange: "last7days" as const,
};

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("<RecommendationFeedback>", () => {
  it("renders thumbs-up + thumbs-down buttons", () => {
    const html = render(<RecommendationFeedback {...baseProps} />);
    expect(html).toContain('data-feedback-thumb="up"');
    expect(html).toContain('data-feedback-thumb="down"');
  });

  it("attaches accessible aria-label keys", () => {
    const html = render(<RecommendationFeedback {...baseProps} />);
    expect(html).toContain('aria-label="Helpful');
    expect(html).toContain('aria-label="Not helpful');
  });

  it("translates the labels to German when locale=de", () => {
    const html = render(<RecommendationFeedback {...baseProps} />, "de");
    expect(html).toContain("Hilfreich");
    expect(html).toContain("Nicht hilfreich");
  });

  it("renders the 'thanks for your feedback' confirmation when initialState=submitted-up", () => {
    const html = render(
      <RecommendationFeedback {...baseProps} initialState="submitted-up" />,
    );
    // Confirmation text replaces both buttons.
    expect(html).toContain("Thanks");
    // Highlighted thumb-up still rendered for context.
    expect(html).toContain('data-feedback-confirmed="up"');
    // The opposite button should NOT be re-clickable.
    expect(html).not.toContain('data-feedback-thumb="down"');
  });

  it("renders the 'already rated' state with the prior verdict highlighted", () => {
    const html = render(
      <RecommendationFeedback
        {...baseProps}
        initialState="already-rated-down"
      />,
    );
    expect(html).toContain('data-feedback-already-rated="down"');
    // Buttons are not interactive in this state.
    expect(html).not.toContain('data-feedback-thumb="up"');
    expect(html).not.toContain('data-feedback-thumb="down"');
  });

  it("buttons carry type=button so they don't accidentally submit a parent form", () => {
    const html = render(<RecommendationFeedback {...baseProps} />);
    // Both up + down buttons must declare type=button.
    const upMatch = html.match(/<button[^>]*data-feedback-thumb="up"[^>]*>/);
    const downMatch = html.match(
      /<button[^>]*data-feedback-thumb="down"[^>]*>/,
    );
    expect(upMatch?.[0]).toContain('type="button"');
    expect(downMatch?.[0]).toContain('type="button"');
  });
});
