import { describe, expect, it } from "vitest";

import { applyOrder, parseModuleListPrefs } from "@/lib/module-list-prefs";

describe("module-list-prefs", () => {
  describe("parseModuleListPrefs", () => {
    it("returns defaults for null / malformed input", () => {
      expect(parseModuleListPrefs(null)).toEqual({
        view: "cards",
        order: [],
        sortDir: "recentDesc",
      });
      expect(parseModuleListPrefs("{not json")).toEqual({
        view: "cards",
        order: [],
        sortDir: "recentDesc",
      });
    });

    it("coerces unknown view / sortDir to defaults but keeps a valid order", () => {
      const parsed = parseModuleListPrefs(
        JSON.stringify({ view: "grid", sortDir: "weird", order: ["a", "b"] }),
      );
      expect(parsed).toEqual({
        view: "cards",
        sortDir: "recentDesc",
        order: ["a", "b"],
      });
    });

    it("round-trips valid values", () => {
      const parsed = parseModuleListPrefs(
        JSON.stringify({ view: "list", sortDir: "manual", order: ["x"] }),
      );
      expect(parsed).toEqual({
        view: "list",
        sortDir: "manual",
        order: ["x"],
      });
    });
  });

  describe("applyOrder", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const idOf = (i: { id: string }) => i.id;

    it("returns the input order when no order is persisted", () => {
      expect(applyOrder(items, [], idOf)).toEqual(items);
    });

    it("places ordered ids first, then the server-default tail", () => {
      const result = applyOrder(items, ["c", "a"], idOf);
      expect(result.map(idOf)).toEqual(["c", "a", "b"]);
    });

    it("ignores ids in the order that are absent from the data", () => {
      const result = applyOrder(items, ["z", "b"], idOf);
      expect(result.map(idOf)).toEqual(["b", "a", "c"]);
    });
  });
});
