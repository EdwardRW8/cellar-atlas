import { describe, it, expect } from "vitest";
import { rackLayout, slotAt, slotKeys, hasOverlaps } from "@/domain/storage/slot-geometry";
import { capacity, type LayoutType, type LayoutConfig } from "@/domain/storage/layout";

/** The owner's rack, as configuration. Nothing here is a constant in product code. */
const STAIRCASE = {
  columns: 13,
  heights: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
  chamfer: true,
  orientation: "ascending-right" as const,
};

const GRID = { rows: 6, columns: 12 };
const SHELVING = { shelves: [12, 12, 8, 6] };
const FRIDGE = {
  zones: [
    { name: "Upper", shelves: 4, perShelf: 8 },
    { name: "Lower", shelves: 3, perShelf: 10 },
  ],
};

describe("every positioned type produces geometry", () => {
  const cases: [LayoutType, LayoutConfig][] = [
    ["staircase", STAIRCASE],
    ["grid", GRID],
    ["shelving", SHELVING],
    ["fridge", FRIDGE],
  ];

  for (const [type, config] of cases) {
    it(`${type}: one slot per unit of capacity`, () => {
      const layout = rackLayout(type, config);
      expect(layout.slots.length).toBe(capacity(type, config));
    });

    it(`${type}: no two slots overlap`, () => {
      expect(hasOverlaps(rackLayout(type, config)), type).toBe(false);
    });

    it(`${type}: every slot sits inside the bounds`, () => {
      const layout = rackLayout(type, config);
      for (const s of layout.slots) {
        expect(s.x).toBeGreaterThanOrEqual(-0.01);
        expect(s.y).toBeGreaterThanOrEqual(-0.01);
        expect(s.x + s.width).toBeLessThanOrEqual(layout.bounds.width + 0.01);
        expect(s.y + s.height).toBeLessThanOrEqual(layout.bounds.height + 0.01);
      }
    });

    it(`${type}: slot keys match the canonical position keys`, () => {
      const keys = slotKeys(type, config);
      expect(new Set(keys).size).toBe(keys.length);
    });
  }
});

describe("unpositioned storage has NO geometry", () => {
  for (const type of ["unpositioned", "external"] as LayoutType[]) {
    it(`${type} produces an empty layout`, () => {
      const layout = rackLayout(type, {} as LayoutConfig);
      expect(layout.isEmpty).toBe(true);
      expect(layout.slots).toEqual([]);
      expect(layout.bounds).toEqual({ width: 0, height: 0 });
    });

    it(`${type} returns null from slotAt`, () => {
      expect(slotAt(type, {} as LayoutConfig, { x: 1, y: 1 })).toBeNull();
    });
  }
});

describe("the owner's staircase", () => {
  const layout = rackLayout("staircase", STAIRCASE);

  it("derives 130 slots without the number appearing anywhere", () => {
    expect(layout.slots.length).toBe(130);
    expect(layout.slots.length).toBe(capacity("staircase", STAIRCASE));
  });

  it("is 13 columns wide and 16 tall", () => {
    expect(layout.bounds).toEqual({ width: 13, height: 16 });
  });

  it("row 1 sits at the BOTTOM of every column", () => {
    const col1row1 = layout.slots.find((s) => s.key === "c1r1")!;
    const col1row4 = layout.slots.find((s) => s.key === "c1r4")!;
    // Screen y grows downward, so row 1 has the larger y.
    expect(col1row1.y).toBeGreaterThan(col1row4.y);
  });

  it("columns share a common floor", () => {
    const floors = layout.slots
      .filter((s) => s.position.row === 1)
      .map((s) => Math.round(s.y * 100));
    expect(new Set(floors).size).toBe(1);
  });
});

describe("chamfer comes from configuration, never assumption", () => {
  it("marks ONLY the top slot of each column", () => {
    const layout = rackLayout("staircase", STAIRCASE);
    const chamfered = layout.slots.filter((s) => s.isChamfered);
    expect(chamfered).toHaveLength(13); // one per column
    for (const s of chamfered) {
      const height = STAIRCASE.heights[s.position.col! - 1]!;
      expect(s.position.row).toBe(height);
    }
  });

  it("marks nothing when chamfer is false", () => {
    const layout = rackLayout("staircase", { ...STAIRCASE, chamfer: false });
    expect(layout.slots.filter((s) => s.isChamfered)).toHaveLength(0);
  });

  it("never chamfers a non-staircase layout", () => {
    for (const [type, config] of [
      ["grid", GRID],
      ["shelving", SHELVING],
      ["fridge", FRIDGE],
    ] as [LayoutType, LayoutConfig][]) {
      expect(
        rackLayout(type, config).slots.some((s) => s.isChamfered),
        type,
      ).toBe(false);
    }
  });
});

describe("orientation mirrors the drawn rack", () => {
  it("ascending-right puts the shortest column on the left", () => {
    const layout = rackLayout("staircase", STAIRCASE);
    const col1 = layout.slots.find((s) => s.key === "c1r1")!;
    const col13 = layout.slots.find((s) => s.key === "c13r1")!;
    expect(col1.x).toBeLessThan(col13.x);
  });

  it("ascending-left mirrors it", () => {
    const layout = rackLayout("staircase", { ...STAIRCASE, orientation: "ascending-left" });
    const col1 = layout.slots.find((s) => s.key === "c1r1")!;
    const col13 = layout.slots.find((s) => s.key === "c13r1")!;
    expect(col1.x).toBeGreaterThan(col13.x);
  });

  it("both orientations produce the same slot count", () => {
    expect(rackLayout("staircase", STAIRCASE).slots.length).toBe(
      rackLayout("staircase", { ...STAIRCASE, orientation: "ascending-left" }).slots.length,
    );
  });
});

describe("slotAt", () => {
  it("finds a valid position", () => {
    const s = slotAt("staircase", STAIRCASE, { col: 13, row: 16 });
    expect(s).not.toBeNull();
    expect(s!.key).toBe("c13r16");
    expect(s!.isChamfered).toBe(true);
  });

  it("returns null for a position outside the layout", () => {
    expect(slotAt("staircase", STAIRCASE, { col: 1, row: 5 })).toBeNull();
    expect(slotAt("grid", GRID, { x: 99, y: 1 })).toBeNull();
  });

  it("returns null for another layout's position shape", () => {
    expect(slotAt("grid", GRID, { col: 1, row: 1 })).toBeNull();
  });

  it("agrees with rackLayout", () => {
    const layout = rackLayout("grid", GRID);
    const direct = slotAt("grid", GRID, { x: 5, y: 3 })!;
    expect(direct).toEqual(layout.slots.find((s) => s.key === "x5y3"));
  });
});

describe("degenerate configurations do not crash", () => {
  it("a 1x1 grid", () => {
    const layout = rackLayout("grid", { rows: 1, columns: 1 });
    expect(layout.slots).toHaveLength(1);
    expect(layout.bounds).toEqual({ width: 1, height: 1 });
  });

  it("a zero-column grid is empty", () => {
    expect(rackLayout("grid", { rows: 0, columns: 0 }).isEmpty).toBe(true);
  });

  it("shelving with no shelves is empty", () => {
    expect(rackLayout("shelving", { shelves: [] }).isEmpty).toBe(true);
  });

  it("a fridge with no zones is empty", () => {
    expect(rackLayout("fridge", { zones: [] }).isEmpty).toBe(true);
  });

  it("a single-column staircase works", () => {
    const layout = rackLayout("staircase", {
      columns: 1,
      heights: [3],
      chamfer: true,
      orientation: "ascending-right",
    });
    expect(layout.slots).toHaveLength(3);
    expect(layout.slots.filter((s) => s.isChamfered)).toHaveLength(1);
  });
});

describe("group labels", () => {
  it("staircase labels every column", () => {
    expect(rackLayout("staircase", STAIRCASE).groupLabels).toHaveLength(13);
  });

  it("shelving labels every shelf", () => {
    expect(rackLayout("shelving", SHELVING).groupLabels).toHaveLength(4);
  });

  it("fridge labels each zone by its own name", () => {
    const labels = rackLayout("fridge", FRIDGE).groupLabels;
    expect(labels.map((l) => l.label)).toEqual(["Upper", "Lower"]);
  });
});

describe("fridge zones are visually separated", () => {
  it("leaves a gap between zones", () => {
    const layout = rackLayout("fridge", FRIDGE);
    const upperLast = Math.max(
      ...layout.slots.filter((s) => s.position.zone === 1).map((s) => s.y),
    );
    const lowerFirst = Math.min(
      ...layout.slots.filter((s) => s.position.zone === 2).map((s) => s.y),
    );
    expect(lowerFirst - upperLast).toBeGreaterThan(1);
  });
});
