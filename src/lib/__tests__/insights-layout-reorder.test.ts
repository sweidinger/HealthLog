import { describe, it, expect } from "vitest";
import { reorderById } from "@/lib/insights-layout-reorder";

describe("reorderById", () => {
  const rows = [
    { id: "a", order: 0, visible: true },
    { id: "b", order: 1, visible: false },
    { id: "c", order: 2, visible: true },
  ];

  it("moves a row forward and renumbers densely", () => {
    const next = reorderById(rows, "a", "c");
    expect(next.map((r) => r.id)).toEqual(["b", "c", "a"]);
    expect(next.map((r) => r.order)).toEqual([0, 1, 2]);
  });

  it("moves a row backward and renumbers densely", () => {
    const next = reorderById(rows, "c", "a");
    expect(next.map((r) => r.id)).toEqual(["c", "a", "b"]);
    expect(next.map((r) => r.order)).toEqual([0, 1, 2]);
  });

  it("preserves every non-order field on each row", () => {
    const next = reorderById(rows, "a", "b");
    const moved = next.find((r) => r.id === "a");
    expect(moved?.visible).toBe(true);
    const hidden = next.find((r) => r.id === "b");
    expect(hidden?.visible).toBe(false);
  });

  it("is a no-op (but still densely renumbered) when ids match", () => {
    const next = reorderById(rows, "b", "b");
    expect(next.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(next.map((r) => r.order)).toEqual([0, 1, 2]);
  });

  it("returns a densely renumbered copy when an id is missing", () => {
    const sparse = [
      { id: "a", order: 5 },
      { id: "b", order: 9 },
    ];
    const next = reorderById(sparse, "a", "zzz");
    expect(next).toEqual([
      { id: "a", order: 0 },
      { id: "b", order: 1 },
    ]);
  });

  it("does not mutate the input array or its rows", () => {
    const input = [
      { id: "a", order: 0 },
      { id: "b", order: 1 },
    ];
    const snapshot = JSON.parse(JSON.stringify(input));
    reorderById(input, "a", "b");
    expect(input).toEqual(snapshot);
  });

  it("sorts an unsorted input by order before reordering", () => {
    const unsorted = [
      { id: "c", order: 2 },
      { id: "a", order: 0 },
      { id: "b", order: 1 },
    ];
    const next = reorderById(unsorted, "a", "c");
    expect(next.map((r) => r.id)).toEqual(["b", "c", "a"]);
  });
});
