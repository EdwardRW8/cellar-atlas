/**
 * Bottle size.
 *
 * ── COMMON SIZES ARE SHORTCUTS, NOT THE DOMAIN ──────────────────────────
 * A bottle size is any sensible positive whole number of millilitres, stored
 * canonically as `<n>ml` — "200ml", "500ml", "1000ml". The common sizes below
 * are UI conveniences only. A collector with a 250ml, 500ml or 1000ml bottle
 * records it as it is; no release is needed to allow a new size.
 *
 * The same rule is enforced by the database (migration 017,
 * `is_valid_bottle_size`), so the application is not the only guard.
 *
 * ── THE UPPER BOUND ─────────────────────────────────────────────────────
 * 50,000 ml (50 litres). The largest named wine formats — Melchizedek and
 * Midas, around 30 litres — sit well inside it, with headroom for anything
 * larger that is still plausibly a bottle. What it rejects is the obvious
 * slip: an extra zero on a 6-litre Methuselah reads 60,000 and is refused
 * rather than recorded. It is a sanity bound, not a list of formats.
 */

/** Canonical form: a positive whole number of millilitres, then "ml". */
export type BottleSize = `${number}ml`;

export const MIN_BOTTLE_ML = 1;
export const MAX_BOTTLE_ML = 50_000;

/** The documented default — unchanged everywhere it applied before. */
export const DEFAULT_BOTTLE_SIZE: BottleSize = "750ml";

/**
 * Quick-select choices. NOT a whitelist: nothing validates against this list.
 * 200ml is included because it occurs in real collections.
 */
export const COMMON_BOTTLE_SIZES: readonly BottleSize[] = [
  "200ml",
  "375ml",
  "750ml",
  "1500ml",
  "3000ml",
  "6000ml",
];

/** No leading zero, no sign, no decimals, no space, lower-case "ml". */
const CANONICAL = /^[1-9][0-9]*ml$/;

/** Is this already a valid canonical bottle size? */
export function isBottleSize(value: unknown): value is BottleSize {
  if (typeof value !== "string" || !CANONICAL.test(value)) return false;
  const ml = Number(value.slice(0, -2));
  return ml >= MIN_BOTTLE_ML && ml <= MAX_BOTTLE_ML;
}

/** The canonical size for a whole number of millilitres, or null. */
export function bottleSizeFromMl(ml: number): BottleSize | null {
  if (!Number.isInteger(ml) || ml < MIN_BOTTLE_ML || ml > MAX_BOTTLE_ML) return null;
  return `${ml}ml`;
}

/**
 * A volume typed by a person, e.g. into the "Volume (ml)" field.
 *
 * Whole digits only. No units are interpreted: "75cl", "0.75", "1.5l" are
 * refused rather than converted, because guessing a unit could store the
 * wrong size silently.
 */
export function parseMillilitres(text: string): BottleSize | null {
  const t = text.trim();
  if (!/^[0-9]+$/.test(t)) return null;
  return bottleSizeFromMl(Number(t));
}

/** Millilitres from a canonical size, for display or editing. */
export function millilitresOf(size: BottleSize): number {
  return Number(size.slice(0, -2));
}
