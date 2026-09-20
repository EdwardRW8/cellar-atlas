import { describe, it, expect } from "vitest";
import { computeOccupancy, findGeometryConflicts } from "@/domain/storage/occupancy";
import {
  validatePosition,
  type LayoutType,
  type LayoutConfig,
} from "@/domain/storage/layout";

const STAIRCASE = {
  columns: 13,
  heights: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
  chamfer: true,
  orientation: "ascending-right" as const,
};

describe("occupancy is derived from configuration", () => {
  it("derives 130 for the owner's staircase without hard-coding it", () => {
    const o = computeOccupancy(12, "staircase", STAIRCASE);
    expect(o.capacity).toBe(130);
    expect(o.free).toBe(118);
    expect(o.percentFull).toBe(9);
    expect(o.isFull).toBe(false);
  });

  it("derives a different capacity for a different staircase", () => {
    const o = computeOccupancy(0, "staircase", {
      columns: 3,
      heights: [2, 3, 4],
      chamfer: false,
      orientation: "ascending-right",
    });
    expect(o.capacity).toBe(9);
  });

  it("handles every bounded layout type", () => {
    const cases: [LayoutType, LayoutConfig, number][] = [
      ["grid", { rows: 6, columns: 12 }, 72],
      ["shelving", { shelves: [12, 12, 8, 6] }, 38],
      ["fridge", { zones: [{ name: "A", shelves: 4, perShelf: 8 }] }, 32],
    ];
    for (const [type, config, expected] of cases) {
      expect(computeOccupancy(0, type, config).capacity, type).toBe(expected);
    }
  });

  it("reports full at capacity", () => {
    const o = computeOccupancy(130, "staircase", STAIRCASE);
    expect(o.isFull).toBe(true);
    expect(o.free).toBe(0);
    expect(o.percentFull).toBe(100);
  });

  it("never reports negative free space if over capacity", () => {
    const o = computeOccupancy(140, "staircase", STAIRCASE);
    expect(o.free).toBe(0);
    expect(o.isFull).toBe(true);
  });

  it("unbounded storage has NULL capacity, not zero", () => {
    for (const type of ["unpositioned", "external"] as LayoutType[]) {
      const o = computeOccupancy(200, type, {});
      expect(o.capacity, type).toBeNull();
      expect(o.free, type).toBeNull();
      expect(o.percentFull, type).toBeNull();
      expect(o.isFull, type).toBe(false);
    }
  });

  it("a location with NO layout is unbounded", () => {
    const o = computeOccupancy(5, null, null);
    expect(o.capacity).toBeNull();
    expect(o.label).toBe("5 bottles");
  });

  it("labels empty unbounded storage sensibly", () => {
    expect(computeOccupancy(0, null, null).label).toBe("Empty");
  });

  it("labels bounded storage with free count", () => {
    expect(computeOccupancy(12, "staircase", STAIRCASE).label).toBe("12 of 130 · 118 free");
  });
});

describe("geometry conflicts mirror the database check", () => {
  const bottles = [
    { id: "b1", position: { x: 1, y: 1 }, positionKey: "x1y1", isActive: true },
    { id: "b2", position: { x: 1, y: 4 }, positionKey: "x1y4", isActive: true },
    { id: "b3", position: { x: 2, y: 2 }, positionKey: "x2y2", isActive: true },
  ];

  it("finds NO conflict when every position survives", () => {
    const c = findGeometryConflicts(
      bottles,
      "grid",
      { rows: 8, columns: 8 },
      validatePosition,
    );
    expect(c).toEqual([]);
  });

  it("THE CRITICAL CASE: a same-capacity reshape is flagged", () => {
    // 4x4 = 16 and 8x2 = 16. Capacity comparison would see no change.
    const c = findGeometryConflicts(
      bottles,
      "grid",
      { rows: 2, columns: 8 },
      validatePosition,
    );
    expect(c).toHaveLength(1);
    expect(c[0]!.positionKey).toBe("x1y4");
  });

  it("flags every orphaned bottle, not just the first", () => {
    const c = findGeometryConflicts(
      bottles,
      "grid",
      { rows: 1, columns: 1 },
      validatePosition,
    );
    expect(c).toHaveLength(2);
    expect(c.map((x) => x.positionKey).sort()).toEqual(["x1y4", "x2y2"]);
  });

  it("gives a reason for each conflict", () => {
    const c = findGeometryConflicts(
      bottles,
      "grid",
      { rows: 2, columns: 8 },
      validatePosition,
    );
    expect(c[0]!.reason).toMatch(/exceeds 2 rows/);
  });

  it("ignores bottles that are no longer in the cellar", () => {
    const withConsumed = [...bottles.map((b) => ({ ...b, isActive: false }))];
    expect(
      findGeometryConflicts(
        withConsumed,
        "grid",
        { rows: 1, columns: 1 },
        validatePosition,
      ),
    ).toEqual([]);
  });

  it("ignores unpositioned bottles", () => {
    const unpositioned = [{ id: "b9", position: null, positionKey: null, isActive: true }];
    expect(
      findGeometryConflicts(
        unpositioned,
        "grid",
        { rows: 1, columns: 1 },
        validatePosition,
      ),
    ).toEqual([]);
  });

  it("flags a TYPE change that invalidates positions", () => {
    const c = findGeometryConflicts(
      bottles,
      "staircase",
      {
        columns: 4,
        heights: [4, 4, 4, 4],
        chamfer: false,
        orientation: "ascending-right",
      },
      validatePosition,
    );
    expect(c).toHaveLength(3); // {x,y} means nothing to a staircase
  });
});
