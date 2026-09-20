/**
 * Slot geometry — where each slot sits, in normalised space.
 *
 * The renderer must not know how any layout is shaped. It receives a flat
 * list of rectangles and draws them. Every piece of layout-specific geometry
 * lives here, beside `capacity()` and `validatePosition()`, and dispatches on
 * type exactly as they do.
 *
 * ADDITIVE ONLY. `capacity`, `validatePosition`, `enumeratePositions` and
 * `freePositions` are untouched.
 *
 * ── COORDINATE SPACE ─────────────────────────────────────────────────────
 * Slots are emitted in a 0-based unit grid: one slot is 1 wide and 1 tall,
 * with a small gap baked into the drawn size rather than the spacing. The
 * renderer scales this into an SVG viewBox, so nothing here depends on pixels,
 * screen size or zoom.
 *
 * `docs/storage-model.md` names this function `slotAt`. It is provided under
 * that name; `rackLayout` is the bulk form the renderer actually needs.
 */

import {
  isPositionedType,
  enumeratePositions,
  validatePosition,
  positionToRecord,
  type LayoutType,
  type LayoutConfig,
  type Position,
  type StaircaseConfig,
  type GridConfig,
  type ShelvingConfig,
  type FridgeConfig,
} from "./layout";

export interface Slot {
  /** Canonical key — matches `bottles.position_key`. */
  key: string;
  position: Record<string, number>;
  /** Unit-grid coordinates. Origin top-left. */
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * A chamfered slot is a cut corner at the top of a staircase column.
   * Purely visual; it is still a real, usable slot.
   */
  isChamfered: boolean;
  /** Grouping index — column, shelf or zone, depending on the type. */
  group: number;
}

export interface RackLayout {
  slots: Slot[];
  /** Bounding box in the same unit grid. */
  bounds: { width: number; height: number };
  /** Labels for the grouping axis, e.g. column numbers. */
  groupLabels: { group: number; label: string; x: number }[];
  /** True when this layout has no slots at all. */
  isEmpty: boolean;
}

const EMPTY: RackLayout = {
  slots: [],
  bounds: { width: 0, height: 0 },
  groupLabels: [],
  isEmpty: true,
};

/** Gap between slots, as a fraction of one unit. */
const GAP = 0.12;
const SIZE = 1 - GAP;

function keyFor(type: LayoutType, config: LayoutConfig, position: Position): string | null {
  const r = validatePosition(type, config, position);
  return r.valid ? r.key : null;
}

// ── STAIRCASE ─────────────────────────────────────────────────────────────

/**
 * Columns of differing height, aligned to a common floor.
 *
 * `orientation` decides which end is tallest. `ascending-right` means column
 * 1 is shortest and sits on the left; `ascending-left` mirrors it, so the
 * drawn rack matches the physical one.
 *
 * Rows count upward from the floor, so row 1 is the bottom. Screen y grows
 * downward, hence the inversion.
 */
function staircaseLayout(c: StaircaseConfig): RackLayout {
  const heights = c.heights;
  const columns = heights.length;
  const tallest = Math.max(...heights, 0);
  if (columns === 0 || tallest === 0) return EMPTY;

  const slots: Slot[] = [];
  const groupLabels: RackLayout["groupLabels"] = [];

  for (let i = 0; i < columns; i++) {
    const colNumber = i + 1;
    const height = heights[i]!;

    const drawnColumn = c.orientation === "ascending-left" ? columns - 1 - i : i;

    groupLabels.push({
      group: colNumber,
      label: String(colNumber),
      x: drawnColumn + SIZE / 2,
    });

    for (let row = 1; row <= height; row++) {
      const position = { col: colNumber, row };
      const key = keyFor("staircase", c, position as Position);
      if (key === null) continue;

      slots.push({
        key,
        position: { col: colNumber, row },
        x: drawnColumn + GAP / 2,
        // Row 1 at the bottom of the tallest column's span.
        y: tallest - row + GAP / 2,
        width: SIZE,
        height: SIZE,
        // Only the topmost slot of a column can be chamfered.
        isChamfered: Boolean(c.chamfer) && row === height,
        group: colNumber,
      });
    }
  }

  return {
    slots,
    bounds: { width: columns, height: tallest },
    groupLabels,
    isEmpty: slots.length === 0,
  };
}

// ── GRID ──────────────────────────────────────────────────────────────────

function gridLayout(c: GridConfig): RackLayout {
  if (c.rows < 1 || c.columns < 1) return EMPTY;

  const slots: Slot[] = [];
  for (let y = 1; y <= c.rows; y++) {
    for (let x = 1; x <= c.columns; x++) {
      const key = keyFor("grid", c, { x, y } as Position);
      if (key === null) continue;
      slots.push({
        key,
        position: { x, y },
        x: x - 1 + GAP / 2,
        y: y - 1 + GAP / 2,
        width: SIZE,
        height: SIZE,
        isChamfered: false,
        group: x,
      });
    }
  }

  return {
    slots,
    bounds: { width: c.columns, height: c.rows },
    groupLabels: Array.from({ length: c.columns }, (_, i) => ({
      group: i + 1,
      label: String(i + 1),
      x: i + SIZE / 2,
    })),
    isEmpty: slots.length === 0,
  };
}

// ── SHELVING ──────────────────────────────────────────────────────────────

/** Shelves stack downward; shelf 1 is the top, as on a real unit. */
function shelvingLayout(c: ShelvingConfig): RackLayout {
  const shelves = c.shelves;
  if (shelves.length === 0) return EMPTY;
  const widest = Math.max(...shelves, 0);
  if (widest === 0) return EMPTY;

  const slots: Slot[] = [];
  shelves.forEach((count, i) => {
    const shelf = i + 1;
    for (let index = 1; index <= count; index++) {
      const key = keyFor("shelving", c, { shelf, index } as Position);
      if (key === null) continue;
      slots.push({
        key,
        position: { shelf, index },
        x: index - 1 + GAP / 2,
        y: i + GAP / 2,
        width: SIZE,
        height: SIZE,
        isChamfered: false,
        group: shelf,
      });
    }
  });

  return {
    slots,
    bounds: { width: widest, height: shelves.length },
    groupLabels: shelves.map((_, i) => ({
      group: i + 1,
      label: `S${i + 1}`,
      x: -0.6,
    })),
    isEmpty: slots.length === 0,
  };
}

// ── FRIDGE ────────────────────────────────────────────────────────────────

/** Zones stack vertically, each contributing its own shelves. */
function fridgeLayout(c: FridgeConfig): RackLayout {
  const zones = c.zones;
  if (zones.length === 0) return EMPTY;

  const slots: Slot[] = [];
  const groupLabels: RackLayout["groupLabels"] = [];
  let widest = 0;
  let cursorY = 0;

  zones.forEach((zone, zi) => {
    const zoneNumber = zi + 1;
    groupLabels.push({
      group: zoneNumber,
      label: zone.name || `Z${zoneNumber}`,
      x: -0.6,
    });

    for (let shelf = 1; shelf <= zone.shelves; shelf++) {
      for (let index = 1; index <= zone.perShelf; index++) {
        const position = { zone: zoneNumber, shelf, index };
        const key = keyFor("fridge", c, position as Position);
        if (key === null) continue;
        slots.push({
          key,
          position: { zone: zoneNumber, shelf, index },
          x: index - 1 + GAP / 2,
          y: cursorY + shelf - 1 + GAP / 2,
          width: SIZE,
          height: SIZE,
          isChamfered: false,
          group: zoneNumber,
        });
      }
      widest = Math.max(widest, zone.perShelf);
    }
    // A blank row between zones, so the divide is visible.
    cursorY += zone.shelves + 0.4;
  });

  return {
    slots,
    bounds: { width: widest, height: Math.max(0, cursorY - 0.4) },
    groupLabels,
    isEmpty: slots.length === 0,
  };
}

// ── DISPATCH ──────────────────────────────────────────────────────────────

/**
 * Every slot in a layout, with its geometry.
 *
 * Returns an empty layout for unpositioned and external storage — those have
 * no slots, and no caller may assume otherwise.
 */
export function rackLayout(type: LayoutType, config: LayoutConfig): RackLayout {
  if (!isPositionedType(type)) return EMPTY;

  switch (type) {
    case "staircase":
      return staircaseLayout(config as StaircaseConfig);
    case "grid":
      return gridLayout(config as GridConfig);
    case "shelving":
      return shelvingLayout(config as ShelvingConfig);
    case "fridge":
      return fridgeLayout(config as FridgeConfig);
    default:
      return EMPTY;
  }
}

/**
 * Geometry for a single position, or null if it is not a valid slot.
 *
 * The name comes from the contract in `docs/storage-model.md`.
 */
export function slotAt(
  type: LayoutType,
  config: LayoutConfig,
  position: Position | Record<string, number>,
): Slot | null {
  if (!isPositionedType(type)) return null;

  const result = validatePosition(type, config, position);
  if (!result.valid) return null;

  return rackLayout(type, config).slots.find((s) => s.key === result.key) ?? null;
}

/** All slot keys, for quick occupancy lookups. */
export function slotKeys(type: LayoutType, config: LayoutConfig): string[] {
  return rackLayout(type, config).slots.map((s) => s.key);
}

/**
 * Sanity check used by tests: no two slots may overlap.
 *
 * A renderer that draws overlapping slots is showing the user a rack that
 * does not exist.
 */
export function hasOverlaps(layout: RackLayout): boolean {
  const seen = new Set<string>();
  for (const s of layout.slots) {
    const cell = `${Math.round(s.x * 100)}:${Math.round(s.y * 100)}`;
    if (seen.has(cell)) return true;
    seen.add(cell);
  }
  return false;
}

export { positionToRecord, enumeratePositions };
