import { describe, it, expect } from "vitest";
import {
  capacity,
  validatePosition,
  enumeratePositions,
  freePositions,
  isPositionedType,
  type StaircaseConfig,
  type GridConfig,
  type ShelvingConfig,
  type FridgeConfig,
} from "@/domain/storage/layout";

/**
 * The owner's rack, expressed purely as data. It is a user-created layout,
 * NOT a global default — no seed migration creates it (amendment 1).
 */
const OWNER_RACK: StaircaseConfig = {
  columns: 13,
  heights: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
  chamfer: true,
  orientation: "ascending-right",
};

describe("staircase — the owner's rack", () => {
  it("capacity is 130, derived not asserted", () => {
    expect(capacity("staircase", OWNER_RACK)).toBe(130);
  });

  it("enumerates exactly 130 positions", () => {
    expect(enumeratePositions("staircase", OWNER_RACK)).toHaveLength(130);
  });

  it("column 1 holds 4 bottles, column 13 holds 16", () => {
    const positions = enumeratePositions("staircase", OWNER_RACK);
    expect(positions.filter((p) => "col" in p && p.col === 1)).toHaveLength(4);
    expect(positions.filter((p) => "col" in p && p.col === 13)).toHaveLength(16);
  });

  it("accepts the extremes of the geometry", () => {
    expect(validatePosition("staircase", OWNER_RACK, { col: 1, row: 1 })).toEqual({
      valid: true,
      key: "c1r1",
    });
    expect(validatePosition("staircase", OWNER_RACK, { col: 13, row: 16 })).toEqual({
      valid: true,
      key: "c13r16",
    });
  });
});

/**
 * AMENDMENT 7 — positions outside the configured geometry must be rejected,
 * not merely positions that are already occupied. These are the tests that
 * prove geometry is enforced rather than assumed.
 */
describe("staircase — invalid geometry is rejected", () => {
  it("rejects a column beyond the rack", () => {
    const r = validatePosition("staircase", OWNER_RACK, { col: 14, row: 1 });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toMatch(/13 columns/);
  });

  it("rejects a row beyond that column's height", () => {
    // Column 1 holds only 4 bottles — row 5 does not exist there.
    const r = validatePosition("staircase", OWNER_RACK, { col: 1, row: 5 });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toMatch(/column 1.*4 bottles/);
  });

  it("rejects row 17 even in the tallest column", () => {
    const r = validatePosition("staircase", OWNER_RACK, { col: 13, row: 17 });
    expect(r.valid).toBe(false);
  });

  it("rejects zero and negative coordinates", () => {
    expect(validatePosition("staircase", OWNER_RACK, { col: 0, row: 1 }).valid).toBe(false);
    expect(validatePosition("staircase", OWNER_RACK, { col: 1, row: 0 }).valid).toBe(false);
    expect(validatePosition("staircase", OWNER_RACK, { col: -1, row: 1 }).valid).toBe(
      false,
    );
  });

  it("rejects non-integer coordinates", () => {
    expect(validatePosition("staircase", OWNER_RACK, { col: 1.5, row: 2 }).valid).toBe(
      false,
    );
    expect(validatePosition("staircase", OWNER_RACK, { col: "1", row: 2 }).valid).toBe(
      false,
    );
  });

  it("rejects a position of the wrong shape for this layout", () => {
    // Grid coordinates offered to a staircase.
    expect(validatePosition("staircase", OWNER_RACK, { x: 1, y: 2 }).valid).toBe(false);
  });

  it("rejects a missing position", () => {
    expect(validatePosition("staircase", OWNER_RACK, null).valid).toBe(false);
    expect(validatePosition("staircase", OWNER_RACK, undefined).valid).toBe(false);
  });

  it("rejects every position one row beyond each column", () => {
    // Systematic: for all 13 columns, height+1 must fail.
    for (let col = 1; col <= OWNER_RACK.columns; col++) {
      const beyond = (OWNER_RACK.heights[col - 1] ?? 0) + 1;
      const r = validatePosition("staircase", OWNER_RACK, { col, row: beyond });
      expect(r.valid, `col ${col} row ${beyond} should be invalid`).toBe(false);
    }
  });
});

describe("canonical position keys", () => {
  /**
   * The reason position_key exists: JSONB cannot enforce slot uniqueness
   * alone, because {"col":1,"row":2} and {"row":2,"col":1} are different
   * values but the same physical slot.
   */
  it("key ignores property order", () => {
    const a = validatePosition("staircase", OWNER_RACK, { col: 3, row: 2 });
    const b = validatePosition("staircase", OWNER_RACK, { row: 2, col: 3 });
    expect(a.valid && b.valid).toBe(true);
    if (a.valid && b.valid) expect(a.key).toBe(b.key);
  });

  it("keys are unique across all 130 slots", () => {
    const keys = enumeratePositions("staircase", OWNER_RACK).map((p) => {
      const r = validatePosition("staircase", OWNER_RACK, p);
      return r.valid ? r.key : "INVALID";
    });
    expect(new Set(keys).size).toBe(130);
    expect(keys).not.toContain("INVALID");
  });

  it("distinct layout types produce distinct key formats", () => {
    const grid: GridConfig = { rows: 4, columns: 4 };
    const shelf: ShelvingConfig = { shelves: [10, 10] };
    const fridge: FridgeConfig = { zones: [{ name: "Top", shelves: 2, perShelf: 8 }] };

    const s = validatePosition("staircase", OWNER_RACK, { col: 2, row: 3 });
    const g = validatePosition("grid", grid, { x: 2, y: 3 });
    const h = validatePosition("shelving", shelf, { shelf: 2, index: 3 });
    const f = validatePosition("fridge", fridge, { zone: 1, shelf: 2, index: 3 });

    expect(s.valid && s.key).toBe("c2r3");
    expect(g.valid && g.key).toBe("x2y3");
    expect(h.valid && h.key).toBe("s2i3");
    expect(f.valid && f.key).toBe("z1s2i3");
  });
});

describe("grid", () => {
  const cfg: GridConfig = { rows: 6, columns: 12 };

  it("capacity is rows × columns", () => {
    expect(capacity("grid", cfg)).toBe(72);
  });

  it("rejects coordinates outside the grid", () => {
    expect(validatePosition("grid", cfg, { x: 13, y: 1 }).valid).toBe(false);
    expect(validatePosition("grid", cfg, { x: 1, y: 7 }).valid).toBe(false);
  });

  it("accepts the far corner", () => {
    expect(validatePosition("grid", cfg, { x: 12, y: 6 })).toEqual({
      valid: true,
      key: "x12y6",
    });
  });
});

describe("shelving — non-uniform shelves", () => {
  const cfg: ShelvingConfig = { shelves: [12, 12, 8, 6] };

  it("capacity sums the shelves", () => {
    expect(capacity("shelving", cfg)).toBe(38);
  });

  it("respects each shelf's own capacity", () => {
    // Shelf 4 holds 6 — index 7 does not exist there, but does on shelf 1.
    expect(validatePosition("shelving", cfg, { shelf: 4, index: 7 }).valid).toBe(false);
    expect(validatePosition("shelving", cfg, { shelf: 1, index: 7 }).valid).toBe(true);
  });

  it("rejects a shelf that does not exist", () => {
    expect(validatePosition("shelving", cfg, { shelf: 5, index: 1 }).valid).toBe(false);
  });
});

describe("fridge — zones", () => {
  const cfg: FridgeConfig = {
    zones: [
      { name: "Upper", shelves: 3, perShelf: 8, tempC: 12 },
      { name: "Lower", shelves: 2, perShelf: 10, tempC: 16 },
    ],
  };

  it("capacity sums all zones", () => {
    expect(capacity("fridge", cfg)).toBe(3 * 8 + 2 * 10);
  });

  it("rejects a zone that does not exist", () => {
    expect(validatePosition("fridge", cfg, { zone: 3, shelf: 1, index: 1 }).valid).toBe(
      false,
    );
  });

  it("rejects a shelf outside its zone", () => {
    expect(validatePosition("fridge", cfg, { zone: 2, shelf: 3, index: 1 }).valid).toBe(
      false,
    );
  });

  it("rejects an index beyond that zone's per-shelf capacity", () => {
    expect(validatePosition("fridge", cfg, { zone: 1, shelf: 1, index: 9 }).valid).toBe(
      false,
    );
    expect(validatePosition("fridge", cfg, { zone: 2, shelf: 1, index: 9 }).valid).toBe(
      true,
    );
  });
});

describe("unpositioned and external storage", () => {
  it("have no capacity limit", () => {
    expect(capacity("unpositioned", {})).toBeNull();
    expect(capacity("external", {})).toBeNull();
  });

  it("are not positioned types", () => {
    expect(isPositionedType("unpositioned")).toBe(false);
    expect(isPositionedType("external")).toBe(false);
    expect(isPositionedType("staircase")).toBe(true);
  });

  it("accept a null position and store no key", () => {
    const r = validatePosition("external", {}, null);
    expect(r).toEqual({ valid: true, key: "" });
  });

  it("REJECT a position being set — they have no slots", () => {
    const r = validatePosition("external", {}, { col: 1, row: 1 });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toMatch(/does not have slots/);
  });

  it("enumerate no positions", () => {
    expect(enumeratePositions("unpositioned", {})).toHaveLength(0);
  });
});

describe("free slot allocation", () => {
  it("excludes occupied keys", () => {
    const occupied = new Set(["c1r1", "c1r2"]);
    const free = freePositions("staircase", OWNER_RACK, occupied);
    expect(free).toHaveLength(128);
    expect(free.some((p) => "col" in p && p.col === 1 && p.row === 1)).toBe(false);
  });

  it("returns nothing when the rack is full", () => {
    const all = new Set(
      enumeratePositions("staircase", OWNER_RACK).map((p) => {
        const r = validatePosition("staircase", OWNER_RACK, p);
        return r.valid ? r.key : "";
      }),
    );
    expect(freePositions("staircase", OWNER_RACK, all)).toHaveLength(0);
  });
});

describe("multiple racks are independent", () => {
  const rackA: StaircaseConfig = {
    columns: 13,
    heights: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
    chamfer: true,
    orientation: "ascending-right",
  };
  const rackB: GridConfig = { rows: 5, columns: 5 };

  it("have independent capacities", () => {
    expect(capacity("staircase", rackA)).toBe(130);
    expect(capacity("grid", rackB)).toBe(25);
  });

  it("produce keys that cannot collide across types", () => {
    const a = validatePosition("staircase", rackA, { col: 1, row: 1 });
    const b = validatePosition("grid", rackB, { x: 1, y: 1 });
    expect(a.valid && b.valid).toBe(true);
    if (a.valid && b.valid) expect(a.key).not.toBe(b.key);
  });
});
