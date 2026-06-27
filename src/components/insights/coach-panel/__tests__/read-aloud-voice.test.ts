import { describe, it, expect } from "vitest";

import { pickSpeechVoice, scoreSpeechVoice } from "../message-thread";

type V = { name: string; lang: string; localService?: boolean };

const asVoices = (vs: V[]) => vs as unknown as SpeechSynthesisVoice[];

describe("scoreSpeechVoice", () => {
  it("rejects voices that do not match the target language", () => {
    expect(scoreSpeechVoice({ name: "Samantha", lang: "en-US" }, "de-DE")).toBe(
      -Infinity,
    );
  });

  it("ranks an enhanced/premium voice above a legacy compact one", () => {
    const enhanced = scoreSpeechVoice(
      { name: "Samantha (Enhanced)", lang: "en-US" },
      "en-US",
    );
    const compact = scoreSpeechVoice(
      { name: "Albert", lang: "en-US" },
      "en-US",
    );
    expect(enhanced).toBeGreaterThan(compact);
    expect(compact).toBeLessThan(0);
  });

  it("rewards an exact lang-region match over a bare language match", () => {
    const region = scoreSpeechVoice({ name: "Google", lang: "de-DE" }, "de-DE");
    const bare = scoreSpeechVoice({ name: "Google", lang: "de-AT" }, "de-DE");
    expect(region).toBeGreaterThan(bare);
  });
});

describe("pickSpeechVoice", () => {
  it("returns the best-scoring voice for the locale", () => {
    const chosen = pickSpeechVoice(
      asVoices([
        { name: "Anna", lang: "de-DE", localService: true },
        { name: "Google Deutsch", lang: "de-DE" },
        { name: "Samantha", lang: "en-US" },
      ]),
      "de-DE",
    );
    expect(chosen?.name).toBe("Google Deutsch");
  });

  it("returns null when nothing beats a legacy default", () => {
    const chosen = pickSpeechVoice(
      asVoices([{ name: "Albert", lang: "en-US" }]),
      "en-US",
    );
    expect(chosen).toBeNull();
  });

  it("returns null on an empty voice list (graceful fallback)", () => {
    expect(pickSpeechVoice(asVoices([]), "en-US")).toBeNull();
  });
});
