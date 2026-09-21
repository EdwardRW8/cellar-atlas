/**
 * The downloadable CSV template.
 *
 * Headers match the bulk-import workbook exactly, so an existing workbook
 * exports to CSV and imports without restructuring. The accepted VALUES are
 * the database's, which is where the workbook's own lists diverged.
 *
 * ── FORMULA INJECTION ────────────────────────────────────────────────────
 * A cell beginning =, +, - or @ is executed as a formula by Excel and Sheets.
 * Nothing user-supplied is emitted here, but the escaping helper is defined
 * alongside the template so that any future export path has it to hand rather
 * than reinventing it.
 */

import { COLUMNS } from "./parse";
import {
  CANONICAL_WINE_TYPES,
  CANONICAL_BOTTLE_SIZES,
  CANONICAL_BASES,
  CANONICAL_SOURCES,
} from "./mappings";

const HEADER_ORDER: (keyof typeof COLUMNS)[] = [
  "producer",
  "wineName",
  "vintage",
  "wineType",
  "country",
  "region",
  "appellation",
  "grapes",
  "bottleSize",
  "quantity",
  "drinkFrom",
  "drinkUntil",
  "purchasePrice",
  "purchaseCurrency",
  "purchaseDate",
  "purchaseSource",
  "currentValue",
  "valuationCurrency",
  "valuationBasis",
  "valuationSource",
  "valuationDate",
  "storageLocation",
  "position",
  "status",
  "notes",
  "tastingRating",
  "tastingNotes",
  "tastingDate",
  "tastingContext",
];

/** A worked row showing the shape of every field. */
const EXAMPLE: Record<string, string> = {
  producer: "Château Léoville-Barton",
  wineName: "Saint-Julien",
  vintage: "2016",
  wineType: "Red",
  country: "France",
  region: "Bordeaux",
  appellation: "Saint-Julien",
  // Semicolons, because a comma would split the field.
  grapes: "Cabernet Sauvignon; Merlot",
  bottleSize: "750",
  quantity: "6",
  drinkFrom: "2026",
  drinkUntil: "2045",
  purchasePrice: "62.50",
  purchaseCurrency: "GBP",
  purchaseDate: "2019-11-03",
  purchaseSource: "Example Wine Merchant",
  currentValue: "95.00",
  valuationCurrency: "GBP",
  valuationBasis: "market_estimate",
  valuationSource: "merchant",
  valuationDate: "2026-01-15",
  // Left blank on purpose. Location names and position formats belong to each
  // user's own storage; an example here would teach one particular layout.
  storageLocation: "",
  position: "",
  status: "In cellar",
  notes: "Case of six, in bond until 2021",
  tastingRating: "4",
  tastingNotes: "Still tight, needs another five years",
  tastingDate: "2025-12-24",
  tastingContext: "Christmas dinner",
};

/** Escapes a value for CSV, neutralising formula injection. */
export function escapeCsvValue(value: string): string {
  // A leading =, +, - or @ is executed by spreadsheet software.
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export function buildTemplateCsv(): string {
  const headers = HEADER_ORDER.map((k) => escapeCsvValue(COLUMNS[k]));
  const example = HEADER_ORDER.map((k) => escapeCsvValue(EXAMPLE[k] ?? ""));
  return `${headers.join(",")}\n${example.join(",")}\n`;
}

/** Plain-language guidance shown beside the download. */
export const FIELD_GUIDE: { field: string; guidance: string }[] = [
  { field: COLUMNS.producer, guidance: "Required." },
  { field: COLUMNS.wineName, guidance: "Required. The cuvée or bottling name." },
  {
    field: COLUMNS.wineType,
    guidance: `Required. One of: ${CANONICAL_WINE_TYPES.join(", ")}.`,
  },
  { field: COLUMNS.quantity, guidance: "Required. One row can create many bottles." },
  { field: COLUMNS.vintage, guidance: "A year, or blank for non-vintage." },
  { field: COLUMNS.grapes, guidance: "Separate with semicolons, not commas." },
  {
    field: COLUMNS.bottleSize,
    guidance: `Millilitres. One of: ${CANONICAL_BOTTLE_SIZES.map((s) => s.replace("ml", "")).join(", ")}. Blank means 750. Any other size stops the import so it can be corrected.`,
  },
  {
    field: COLUMNS.purchasePrice,
    guidance:
      "Per bottle, not per case. Leave blank if unknown — it is never assumed to be zero.",
  },
  {
    field: COLUMNS.purchaseCurrency,
    guidance: "Required whenever a price is given. Never assumed.",
  },
  {
    field: COLUMNS.purchaseDate,
    guidance: "YYYY-MM-DD, or blank if unknown. Never filled in for you.",
  },
  { field: COLUMNS.currentValue, guidance: "Per bottle. Needs a currency and a basis." },
  {
    field: COLUMNS.valuationBasis,
    guidance: `What kind of figure it is. One of: ${CANONICAL_BASES.join(", ")}.`,
  },
  {
    field: COLUMNS.valuationSource,
    guidance: `Optional. A source type — ${CANONICAL_SOURCES.join(", ")} — or a reference such as a web address or a merchant's name, which is kept with the valuation. Blank is fine.`,
  },
  {
    field: COLUMNS.storageLocation,
    guidance: "The name of a storage location you already have — not an ID.",
  },
  {
    field: COLUMNS.position,
    guidance:
      "The slot label used by that location's own layout. Formats differ between layouts, so check the location in Cellar Atlas. If it cannot be resolved the bottle imports unpositioned.",
  },
  {
    field: COLUMNS.status,
    guidance: "In cellar, Consumed or Removed. Blank means In cellar.",
  },
  {
    field: COLUMNS.tastingRating,
    guidance: "1 to 5. Recorded once against the wine, not once per bottle.",
  },
];
