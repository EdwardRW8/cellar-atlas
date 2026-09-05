/**
 * Storage layout geometry.
 *
 * Pure functions — no React, no database. Every rack calculation is testable
 * independently of the renderer that draws it.
 *
 * THE CANONICAL POSITION KEY
 *
 * JSONB cannot enforce slot uniqueness on its own: `{"col":1,"row":2}` and
 * `{"row":2,"col":1}` are different values but the same physical slot. So
 * every positioned bottle also carries a `position_key` — a deterministic
 * string derived from the validated position — and the database unique
 * constraint is on that.
 *
 * A position is only ever turned into a key AFTER being validated against
 * its layout's config. An invalid position has no key and cannot be stored.
 */

export type LayoutType =
  "staircase" | "grid" | "shelving" | "fridge" | "unpositioned" | "external";

// ── Config shapes ─────────────────────────────────────────────────────────

export interface StaircaseConfig {
  columns: number;
  /** Bottle capacity of each column, left to right. Length must equal columns. */
  heights: number[];
  chamfer: boolean;
  orientation: "ascending-right" | "ascending-left";
}

export interface GridConfig {
  rows: number;
  columns: number;
}

export interface ShelvingConfig {
  /** Capacity per shelf, top to bottom. Real shelving is rarely uniform. */
  shelves: number[];
}

export interface FridgeZone {
  name: string;
  shelves: number;
  perShelf: number;
  tempC?: number;
}

export interface FridgeConfig {
  zones: FridgeZone[];
}

export interface UnpositionedConfig {
  note?: string;
}

export interface ExternalConfig {
  merchant?: string;
  accountRef?: string;
}

export type LayoutConfig =
  | StaircaseConfig
  | GridConfig
  | ShelvingConfig
  | FridgeConfig
  | UnpositionedConfig
  | ExternalConfig;

// ── Position shapes ───────────────────────────────────────────────────────

export interface StaircasePosition {
  col: number;
  row: number;
}
export interface GridPosition {
  x: number;
  y: number;
}
export interface ShelvingPosition {
  shelf: number;
  index: number;
}
export interface FridgePosition {
  zone: number;
  shelf: number;
  index: number;
}

export type Position = StaircasePosition | GridPosition | ShelvingPosition | FridgePosition;

// ── Validation result ─────────────────────────────────────────────────────

export type PositionResult =
  { valid: true; key: string } | { valid: false; reason: string };

/** Layouts that hold bottles without assigning them a slot. */
export const UNPOSITIONED_TYPES: LayoutType[] = ["unpositioned", "external"];

export function isPositionedType(type: LayoutType): boolean {
  return !UNPOSITIONED_TYPES.includes(type);
}

// ── Integer guard ─────────────────────────────────────────────────────────

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1;
}

// ═══════════════════════════════════════════════════════════════════════════
// STAIRCASE
// ═══════════════════════════════════════════════════════════════════════════

export function staircaseCapacity(c: StaircaseConfig): number {
  return c.heights.reduce((a, b) => a + b, 0);
}

export function staircaseValidate(c: StaircaseConfig, p: unknown): PositionResult {
  if (!p || typeof p !== "object") {
    return { valid: false, reason: "Position must be an object" };
  }
  const { col, row } = p as Partial<StaircasePosition>;

  if (!isPositiveInt(col)) {
    return {
      valid: false,
      reason: `Column must be a positive integer, got ${String(col)}`,
    };
  }
  if (!isPositiveInt(row)) {
    return { valid: false, reason: `Row must be a positive integer, got ${String(row)}` };
  }
  if (col > c.columns) {
    return {
      valid: false,
      reason: `Column ${col} is outside this rack — it has ${c.columns} columns`,
    };
  }
  const height = c.heights[col - 1];
  if (height === undefined) {
    return { valid: false, reason: `Column ${col} has no defined height` };
  }
  if (row > height) {
    return {
      valid: false,
      reason: `Row ${row} is outside column ${col} — that column holds ${height} bottles`,
    };
  }
  return { valid: true, key: `c${col}r${row}` };
}

export function staircaseEnumerate(c: StaircaseConfig): StaircasePosition[] {
  const out: StaircasePosition[] = [];
  for (let col = 1; col <= c.columns; col++) {
    const h = c.heights[col - 1] ?? 0;
    for (let row = 1; row <= h; row++) out.push({ col, row });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// GRID
// ═══════════════════════════════════════════════════════════════════════════

export function gridCapacity(c: GridConfig): number {
  return c.rows * c.columns;
}

export function gridValidate(c: GridConfig, p: unknown): PositionResult {
  if (!p || typeof p !== "object") {
    return { valid: false, reason: "Position must be an object" };
  }
  const { x, y } = p as Partial<GridPosition>;

  if (!isPositiveInt(x)) {
    return { valid: false, reason: `x must be a positive integer, got ${String(x)}` };
  }
  if (!isPositiveInt(y)) {
    return { valid: false, reason: `y must be a positive integer, got ${String(y)}` };
  }
  if (x > c.columns) {
    return { valid: false, reason: `x ${x} exceeds ${c.columns} columns` };
  }
  if (y > c.rows) {
    return { valid: false, reason: `y ${y} exceeds ${c.rows} rows` };
  }
  return { valid: true, key: `x${x}y${y}` };
}

export function gridEnumerate(c: GridConfig): GridPosition[] {
  const out: GridPosition[] = [];
  for (let y = 1; y <= c.rows; y++) {
    for (let x = 1; x <= c.columns; x++) out.push({ x, y });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// SHELVING
// ═══════════════════════════════════════════════════════════════════════════

export function shelvingCapacity(c: ShelvingConfig): number {
  return c.shelves.reduce((a, b) => a + b, 0);
}

export function shelvingValidate(c: ShelvingConfig, p: unknown): PositionResult {
  if (!p || typeof p !== "object") {
    return { valid: false, reason: "Position must be an object" };
  }
  const { shelf, index } = p as Partial<ShelvingPosition>;

  if (!isPositiveInt(shelf)) {
    return {
      valid: false,
      reason: `Shelf must be a positive integer, got ${String(shelf)}`,
    };
  }
  if (!isPositiveInt(index)) {
    return {
      valid: false,
      reason: `Index must be a positive integer, got ${String(index)}`,
    };
  }
  if (shelf > c.shelves.length) {
    return {
      valid: false,
      reason: `Shelf ${shelf} does not exist — there are ${c.shelves.length} shelves`,
    };
  }
  const cap = c.shelves[shelf - 1];
  if (cap === undefined) {
    return { valid: false, reason: `Shelf ${shelf} has no defined capacity` };
  }
  if (index > cap) {
    return {
      valid: false,
      reason: `Index ${index} is outside shelf ${shelf} — it holds ${cap} bottles`,
    };
  }
  return { valid: true, key: `s${shelf}i${index}` };
}

export function shelvingEnumerate(c: ShelvingConfig): ShelvingPosition[] {
  const out: ShelvingPosition[] = [];
  c.shelves.forEach((cap, i) => {
    for (let index = 1; index <= cap; index++) out.push({ shelf: i + 1, index });
  });
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// FRIDGE
// ═══════════════════════════════════════════════════════════════════════════

export function fridgeCapacity(c: FridgeConfig): number {
  return c.zones.reduce((a, z) => a + z.shelves * z.perShelf, 0);
}

export function fridgeValidate(c: FridgeConfig, p: unknown): PositionResult {
  if (!p || typeof p !== "object") {
    return { valid: false, reason: "Position must be an object" };
  }
  const { zone, shelf, index } = p as Partial<FridgePosition>;

  if (!isPositiveInt(zone)) {
    return { valid: false, reason: `Zone must be a positive integer, got ${String(zone)}` };
  }
  if (!isPositiveInt(shelf)) {
    return {
      valid: false,
      reason: `Shelf must be a positive integer, got ${String(shelf)}`,
    };
  }
  if (!isPositiveInt(index)) {
    return {
      valid: false,
      reason: `Index must be a positive integer, got ${String(index)}`,
    };
  }
  if (zone > c.zones.length) {
    return {
      valid: false,
      reason: `Zone ${zone} does not exist — there are ${c.zones.length} zones`,
    };
  }
  const z = c.zones[zone - 1];
  if (!z) return { valid: false, reason: `Zone ${zone} is not configured` };
  if (shelf > z.shelves) {
    return {
      valid: false,
      reason: `Shelf ${shelf} is outside zone ${zone} — it has ${z.shelves} shelves`,
    };
  }
  if (index > z.perShelf) {
    return {
      valid: false,
      reason: `Index ${index} exceeds ${z.perShelf} bottles per shelf in zone ${zone}`,
    };
  }
  return { valid: true, key: `z${zone}s${shelf}i${index}` };
}

export function fridgeEnumerate(c: FridgeConfig): FridgePosition[] {
  const out: FridgePosition[] = [];
  c.zones.forEach((z, zi) => {
    for (let shelf = 1; shelf <= z.shelves; shelf++) {
      for (let index = 1; index <= z.perShelf; index++) {
        out.push({ zone: zi + 1, shelf, index });
      }
    }
  });
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// DISPATCH
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Capacity of a layout. Null means unbounded — floor cases and merchant
 * storage hold as many bottles as you like.
 */
export function capacity(type: LayoutType, config: LayoutConfig): number | null {
  switch (type) {
    case "staircase":
      return staircaseCapacity(config as StaircaseConfig);
    case "grid":
      return gridCapacity(config as GridConfig);
    case "shelving":
      return shelvingCapacity(config as ShelvingConfig);
    case "fridge":
      return fridgeCapacity(config as FridgeConfig);
    case "unpositioned":
    case "external":
      return null;
  }
}

/**
 * Validate a position against a layout and return its canonical key.
 *
 * This is the single gate. A position that does not pass here has no key,
 * and without a key it cannot be written to the database.
 */
export function validatePosition(
  type: LayoutType,
  config: LayoutConfig,
  position: unknown,
): PositionResult {
  if (!isPositionedType(type)) {
    // Unpositioned layouts must NOT carry a position.
    if (position === null || position === undefined) {
      return { valid: true, key: "" }; // empty key → stored as NULL
    }
    return {
      valid: false,
      reason: `A ${type} location does not have slots, so a position cannot be set`,
    };
  }

  if (position === null || position === undefined) {
    return { valid: false, reason: `A ${type} location requires a position` };
  }

  switch (type) {
    case "staircase":
      return staircaseValidate(config as StaircaseConfig, position);
    case "grid":
      return gridValidate(config as GridConfig, position);
    case "shelving":
      return shelvingValidate(config as ShelvingConfig, position);
    case "fridge":
      return fridgeValidate(config as FridgeConfig, position);
    default:
      return { valid: false, reason: `Unknown layout type ${type}` };
  }
}

export function enumeratePositions(type: LayoutType, config: LayoutConfig): Position[] {
  switch (type) {
    case "staircase":
      return staircaseEnumerate(config as StaircaseConfig);
    case "grid":
      return gridEnumerate(config as GridConfig);
    case "shelving":
      return shelvingEnumerate(config as ShelvingConfig);
    case "fridge":
      return fridgeEnumerate(config as FridgeConfig);
    case "unpositioned":
    case "external":
      return [];
  }
}

/** Free slots, given what is already occupied. */
export function freePositions(
  type: LayoutType,
  config: LayoutConfig,
  occupiedKeys: Set<string>,
): Position[] {
  return enumeratePositions(type, config).filter((p) => {
    const r = validatePosition(type, config, p);
    return r.valid && !occupiedKeys.has(r.key);
  });
}
