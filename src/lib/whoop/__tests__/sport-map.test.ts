import { describe, expect, it } from "vitest";

import {
  WHOOP_SPORT_ID_MAP,
  WHOOP_SPORT_NAME_MAP,
  WHOOP_SPORT_TABLE,
  mapWhoopSportType,
  normaliseSportKey,
} from "../sport-map";
import { workoutSportTypeEnum } from "@/lib/validations/workout";

/**
 * `mapWhoopSportType()` fixes the confirmed prod bug: a WHOOP cycling
 * workout wrote a non-canonical `sportType` (`whoop_sport_<id>` or the raw
 * `sport_name`) and never rendered as "cycling" on `/insights/workouts`.
 */

describe("WHOOP_SPORT_TABLE", () => {
  it("maps every documented entry to a value in workoutSportTypeEnum", () => {
    const valid = new Set(workoutSportTypeEnum.options);
    for (const entry of WHOOP_SPORT_TABLE) {
      expect(valid.has(entry.canonical)).toBe(true);
    }
  });

  it("has no duplicate sport_id", () => {
    const ids = WHOOP_SPORT_TABLE.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("normaliseSportKey", () => {
  it("lowercases and collapses whitespace / punctuation to a single underscore", () => {
    expect(normaliseSportKey("Running")).toBe("running");
    expect(normaliseSportKey("Track & Field")).toBe("track_field");
    expect(normaliseSportKey("Hiking/Rucking")).toBe("hiking_rucking");
    expect(normaliseSportKey("hiking_rucking")).toBe("hiking_rucking");
    expect(normaliseSportKey("  Hot Yoga  ")).toBe("hot_yoga");
  });

  it("leaves an existing whoop_sport_<id> placeholder untouched (case aside)", () => {
    expect(normaliseSportKey("whoop_sport_1")).toBe("whoop_sport_1");
  });
});

describe("mapWhoopSportType — the confirmed cycling bug", () => {
  it("resolves WHOOP's cycling sport_id (1) to the canonical bucket", () => {
    expect(mapWhoopSportType(1)).toBe("cycling");
  });

  it("resolves WHOOP's cycling sport_name to the canonical bucket", () => {
    expect(mapWhoopSportType(undefined, "Cycling")).toBe("cycling");
    expect(mapWhoopSportType(undefined, "cycling")).toBe("cycling");
  });

  it("resolves Mountain Biking and Spin sport_ids to cycling too", () => {
    expect(mapWhoopSportType(57)).toBe("cycling");
    expect(mapWhoopSportType(97)).toBe("cycling");
  });
});

describe("mapWhoopSportType — id preferred over name", () => {
  it("prefers sport_id when both fields are present and disagree", () => {
    // Contrived: id says running, name says something unmapped — id wins
    // because it needs no normalisation guesswork.
    expect(
      mapWhoopSportType(0, "some future sport WHOOP hasn't announced"),
    ).toBe("running");
  });

  it("falls back to sport_name when sport_id is absent (the post-2025-09-01 shape)", () => {
    expect(mapWhoopSportType(undefined, "Hiking/Rucking")).toBe("hiking");
  });
});

describe("mapWhoopSportType — unmapped input never falls through to a placeholder", () => {
  it("defaults to other for an unknown sport_id", () => {
    expect(mapWhoopSportType(999_999)).toBe("other");
  });

  it("defaults to other for an unknown sport_name", () => {
    expect(mapWhoopSportType(undefined, "quantum tunnelling")).toBe("other");
  });

  it("defaults to other when neither field is present", () => {
    expect(mapWhoopSportType(undefined, undefined)).toBe("other");
  });

  it("never returns a whoop_sport_<n> string for any input", () => {
    for (const id of [-1, 0, 1, 999_999]) {
      expect(mapWhoopSportType(id)).not.toMatch(/^whoop_sport_/);
    }
    expect(mapWhoopSportType(undefined, "totally unknown")).not.toMatch(
      /^whoop_sport_/,
    );
  });
});

describe("WHOOP_SPORT_ID_MAP / WHOOP_SPORT_NAME_MAP", () => {
  it("expose the same size as the source table (id map)", () => {
    expect(WHOOP_SPORT_ID_MAP.size).toBe(WHOOP_SPORT_TABLE.length);
  });

  it("expose the same size as the source table (name map — every name is unique after normalisation)", () => {
    expect(WHOOP_SPORT_NAME_MAP.size).toBe(WHOOP_SPORT_TABLE.length);
  });
});
