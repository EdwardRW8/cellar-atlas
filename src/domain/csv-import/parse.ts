/**
 * CSV parsing and row validation.
 *
 * ── PARSING ──────────────────────────────────────────────────────────────
 * PapaParse, not string splitting. A wine collection is exactly the data that
 * breaks naïve parsing: "Château Léoville-Barton, Grand Vin" contains a comma
 * inside a quoted field, producers carry accents, and a notes column may hold
 * a line break. UTF-8 is expected and a BOM is stripped.
 *
 * ── VALIDATION ───────────────────────────────────────────────────────────
 * Three outcomes per row, never two:
 *
 *   valid    imports as described
 *   warning  imports, with a compromise stated up front
 *   invalid  BLOCKS the import until corrected
 *
 * Absence is never converted to a value. A missing price stays unknown, a
 * missing valuation stays unknown, and a missing currency is an error rather
 * than a default.
 */

import Papa from "papaparse";
import {
  mapWineType,
  mapBottleSize,
  mapStatus,
  mapValuationBasis,
  mapValuationSource,
  mapCurrency,
  isRejected,
} from "./mappings";

/**
 * Workbook headers, matched case- and space-insensitively.
 *
 * These MUST be the headers of Cellar_Atlas_Bulk_Import_Populated.xlsx
 * exactly. Five of them were previously written differently —
 * "Bottle Size (ml)", "Purchase Price (per bottle)", "Purchase Source",
 * "Current Value (per bottle)", "Position" — and because the template and the
 * tests were generated from THIS object, all three agreed with each other and
 * disagreed with the workbook. An exported workbook would have lost every
 * price, valuation, merchant and position, and defaulted every bottle to
 * 750ml, while the suite stayed green. The normaliser does not strip
 * punctuation, so nothing rescued it.
 *
 * `csv-import-workbook-headers.test.ts` now pins these against the
 * workbook's literal header row.
 */
export const COLUMNS = {
  producer: "Producer",
  wineName: "Wine Name",
  vintage: "Vintage",
  wineType: "Wine Type",
  country: "Country",
  region: "Region",
  appellation: "Appellation",
  grapes: "Grapes",
  bottleSize: "Bottle Size ml",
  quantity: "Quantity",
  drinkFrom: "Drink From",
  drinkUntil: "Drink Until",
  purchasePrice: "Purchase Price per Bottle",
  purchaseCurrency: "Purchase Currency",
  purchaseDate: "Purchase Date",
  purchaseSource: "Merchant / Source",
  currentValue: "Current Valuation per Bottle",
  valuationCurrency: "Valuation Currency",
  valuationBasis: "Valuation Basis",
  valuationSource: "Valuation Source",
  valuationDate: "Valuation Date",
  storageLocation: "Storage Location",
  position: "Storage Position",
  status: "Status",
  notes: "Notes",
  tastingRating: "Tasting Rating",
  tastingNotes: "Tasting Notes",
  tastingDate: "Tasting Date",
  tastingContext: "Tasting Context",
} as const;

export type ColumnKey = keyof typeof COLUMNS;

export type Severity = "valid" | "warning" | "invalid";

export interface RowIssue {
  column: string;
  severity: "warning" | "invalid";
  message: string;
}

/** One CSV row, parsed and checked. */
export interface ParsedRow {
  /** 1-based, matching what a spreadsheet shows. */
  lineNumber: number;
  raw: Record<string, string>;
  severity: Severity;
  issues: RowIssue[];

  producer: string;
  wineName: string;
  wineType: string | null;
  vintage: number | null;
  country: string | null;
  region: string | null;
  appellation: string | null;
  grapes: string[];
  drinkFrom: number | null;
  drinkUntil: number | null;
  notes: string | null;

  bottleSize: string;
  quantity: number;
  status: string;

  /** Null means unknown, never zero. */
  purchasePrice: number | null;
  purchaseCurrency: string | null;
  purchaseDate: string | null;
  purchaseSource: string | null;

  valuation: {
    amount: number;
    currency: string;
    basis: string;
    source: string;
    /** Free-text provenance, when the source column held one. */
    reference: string | null;
    valuedOn: string | null;
  } | null;

  tasting: {
    rating: number | null;
    notes: string | null;
    tastedOn: string | null;
    context: string | null;
  } | null;

  storageLocation: string | null;
  position: string | null;
}

export interface ParseResult {
  rows: ParsedRow[];
  /** Headers present in the file that Cellar Atlas does not use. */
  unknownColumns: string[];
  /** Headers Cellar Atlas needs that the file lacks. */
  missingRequiredColumns: string[];
  fatalError: string | null;
}

const headerKey = (h: string) => h.trim().toLowerCase().replace(/\s+/g, " ");

const LOOKUP = new Map(
  Object.entries(COLUMNS).map(([key, header]) => [headerKey(header), key as ColumnKey]),
);

const REQUIRED_COLUMNS: ColumnKey[] = ["producer", "wineName", "wineType", "quantity"];

/** Parse CSV text. Never throws; a malformed file is a fatal error to display. */
export function parseCsv(text: string): ParseResult {
  // A BOM would otherwise become part of the first header name.
  const clean = text.replace(/^\uFEFF/, "");

  if (!clean.trim()) {
    return {
      rows: [],
      unknownColumns: [],
      missingRequiredColumns: [],
      fatalError: "The file is empty.",
    };
  }

  const parsed = Papa.parse<Record<string, string>>(clean, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });

  const headers = parsed.meta.fields ?? [];
  if (headers.length === 0) {
    return {
      rows: [],
      unknownColumns: [],
      missingRequiredColumns: [],
      fatalError: "No column headers were found. Start from the template.",
    };
  }

  const mappedHeaders = new Map<string, ColumnKey>();
  const unknownColumns: string[] = [];
  for (const h of headers) {
    const key = LOOKUP.get(headerKey(h));
    if (key) mappedHeaders.set(h, key);
    else if (h.trim()) unknownColumns.push(h.trim());
  }

  const present = new Set(mappedHeaders.values());
  const missingRequiredColumns = REQUIRED_COLUMNS.filter((c) => !present.has(c)).map(
    (c) => COLUMNS[c],
  );

  if (missingRequiredColumns.length > 0) {
    return {
      rows: [],
      unknownColumns,
      missingRequiredColumns,
      fatalError: `The file is missing required columns: ${missingRequiredColumns.join(", ")}.`,
    };
  }

  const rows = parsed.data.map((raw, i) => {
    const byKey: Record<string, string> = {};
    for (const [header, key] of mappedHeaders) {
      byKey[key] = (raw[header] ?? "").toString();
    }
    // +2: one for the header row, one for 1-based numbering.
    return validateRow(byKey, i + 2, raw);
  });

  return { rows, unknownColumns, missingRequiredColumns: [], fatalError: null };
}

const text = (v: string | undefined) => (v ?? "").trim();
const blank = (v: string | undefined) => text(v) === "";

function number(v: string | undefined): number | null {
  const t = text(v);
  if (t === "") return null;
  const n = Number(t.replace(/[£$€,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function isIsoDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Validate one row. Pure and independently testable. */
export function validateRow(
  v: Record<string, string>,
  lineNumber: number,
  raw: Record<string, string>,
): ParsedRow {
  const issues: RowIssue[] = [];
  const invalid = (column: string, message: string) =>
    issues.push({ column, severity: "invalid", message });
  const warn = (column: string, message: string) =>
    issues.push({ column, severity: "warning", message });

  // ── Identity ──
  const producer = text(v.producer);
  const wineName = text(v.wineName);
  if (!producer) invalid(COLUMNS.producer, "Producer is required");
  if (!wineName) invalid(COLUMNS.wineName, "Wine name is required");

  // ── Wine type: mandatory since migration 016 ──
  const typeResult = mapWineType(v.wineType ?? "");
  if (isRejected(typeResult)) {
    invalid(COLUMNS.wineType, typeResult.rejected.reason);
  } else if (typeResult.alias) {
    warn(
      COLUMNS.wineType,
      `"${typeResult.alias.from}" will be recorded as "${typeResult.alias.to}"`,
    );
  }

  // ── Vintage ──
  let vintage: number | null = null;
  if (!blank(v.vintage)) {
    const n = number(v.vintage);
    const thisYear = new Date().getFullYear();
    if (n === null || !Number.isInteger(n)) {
      invalid(COLUMNS.vintage, "Vintage must be a whole year, or blank for non-vintage");
    } else if (n < 1800 || n > thisYear + 3) {
      invalid(COLUMNS.vintage, `Vintage must be between 1800 and ${thisYear + 3}`);
    } else {
      vintage = n;
    }
  }

  // ── Quantity ──
  const qty = number(v.quantity);
  let quantity = 0;
  if (qty === null) {
    invalid(COLUMNS.quantity, "Quantity is required");
  } else if (!Number.isInteger(qty) || qty < 1) {
    invalid(COLUMNS.quantity, "Quantity must be a whole number of at least 1");
  } else if (qty > 240) {
    invalid(COLUMNS.quantity, "Quantity over 240 looks like a mistake");
  } else {
    quantity = qty;
  }

  // ── Bottle size ──
  const sizeResult = mapBottleSize(v.bottleSize ?? "");
  if (isRejected(sizeResult)) invalid(COLUMNS.bottleSize, sizeResult.rejected.reason);
  else if (sizeResult.alias) {
    warn(COLUMNS.bottleSize, `Recorded as ${sizeResult.alias.to}`);
  }

  // ── Status ──
  const statusResult = mapStatus(v.status ?? "");
  if (isRejected(statusResult)) invalid(COLUMNS.status, statusResult.rejected.reason);
  const status = isRejected(statusResult) ? "in_cellar" : statusResult.value;
  if (
    !isRejected(statusResult) &&
    statusResult.alias &&
    statusResult.alias.from.trim().toLowerCase().replace(/\s+/g, "_") !== statusResult.value
  ) {
    warn(
      COLUMNS.status,
      `"${statusResult.alias.from}" will be recorded as "${statusResult.value}"`,
    );
  }
  if (status !== "in_cellar") {
    warn(
      COLUMNS.status,
      `Imported into the cellar, then marked "${status}" — history will show both`,
    );
  }

  // ── Drinking window ──
  const drinkFrom = number(v.drinkFrom);
  const drinkUntil = number(v.drinkUntil);
  if (!blank(v.drinkFrom) && drinkFrom === null) {
    invalid(COLUMNS.drinkFrom, "Drink From must be a year");
  }
  if (!blank(v.drinkUntil) && drinkUntil === null) {
    invalid(COLUMNS.drinkUntil, "Drink Until must be a year");
  }
  if (drinkFrom !== null && drinkUntil !== null && drinkFrom > drinkUntil) {
    invalid(COLUMNS.drinkUntil, "Drink Until cannot be before Drink From");
  }

  // ── Purchase: a price REQUIRES a currency; nothing is defaulted ──
  const purchasePrice = number(v.purchasePrice);
  if (!blank(v.purchasePrice) && purchasePrice === null) {
    invalid(COLUMNS.purchasePrice, "Purchase price must be a number");
  }
  if (purchasePrice !== null && purchasePrice < 0) {
    invalid(COLUMNS.purchasePrice, "Purchase price cannot be negative");
  }

  let purchaseCurrency: string | null = null;
  if (purchasePrice !== null) {
    const c = mapCurrency(v.purchaseCurrency ?? "");
    if (isRejected(c)) {
      invalid(
        COLUMNS.purchaseCurrency,
        "A purchase price needs a currency — it is never assumed",
      );
    } else {
      purchaseCurrency = c.value;
    }
  } else if (!blank(v.purchaseCurrency)) {
    warn(COLUMNS.purchaseCurrency, "Currency given with no price — the cost stays unknown");
  }

  let purchaseDate: string | null = null;
  if (!blank(v.purchaseDate)) {
    const d = text(v.purchaseDate);
    if (!isIsoDate(d)) invalid(COLUMNS.purchaseDate, "Date must be YYYY-MM-DD");
    else purchaseDate = d;
  }

  // ── Valuation: all-or-nothing, and never invented ──
  const currentValue = number(v.currentValue);
  if (!blank(v.currentValue) && currentValue === null) {
    invalid(COLUMNS.currentValue, "Current value must be a number");
  }

  let valuation: ParsedRow["valuation"] = null;
  if (currentValue !== null) {
    const currency = mapCurrency(v.valuationCurrency ?? "");
    const basis = mapValuationBasis(v.valuationBasis ?? "");
    const source = mapValuationSource(v.valuationSource ?? "");

    let valuedOn: string | null = null;
    if (!blank(v.valuationDate)) {
      const d = text(v.valuationDate);
      if (!isIsoDate(d)) invalid(COLUMNS.valuationDate, "Date must be YYYY-MM-DD");
      else valuedOn = d;
    }

    if (isRejected(currency)) {
      invalid(
        COLUMNS.valuationCurrency,
        "A valuation needs a currency — it is never assumed",
      );
    }
    if (isRejected(basis)) {
      // The basis says what KIND of number this is — an estimate is not a
      // realised sale — so an unrecognised basis is never guessed. The
      // valuation is skipped; the wine and bottles still import.
      warn(
        COLUMNS.valuationBasis,
        `${basis.rejected.reason}. The valuation will be skipped.`,
      );
    } else if (basis.alias) {
      warn(
        COLUMNS.valuationBasis,
        `"${basis.alias.from}" will be recorded as "${basis.alias.to}"`,
      );
    }
    if (isRejected(source)) {
      invalid(COLUMNS.valuationSource, source.rejected.reason);
    } else if (source.alias) {
      // Every source mapping is previewed, not only the unusual ones.
      warn(
        COLUMNS.valuationSource,
        source.alias.note ??
          `"${source.alias.from}" will be recorded as "${source.alias.to}"`,
      );
    }

    if (!isRejected(currency) && !isRejected(basis) && !isRejected(source)) {
      valuation = {
        amount: currentValue,
        currency: currency.value,
        basis: basis.value,
        source: source.value,
        // Free-text provenance (a URL, a merchant, a sale), stored in the
        // ledger's notes — never coerced into the source-type enum.
        reference: source.reference ?? null,
        valuedOn,
      };
      if (basis.alias) {
        warn(
          COLUMNS.valuationBasis,
          `"${basis.alias.from}" will be recorded as "${basis.alias.to}"`,
        );
      }
    }
  }

  // ── Tasting ──
  const rating = number(v.tastingRating);
  const hasTasting =
    rating !== null ||
    !blank(v.tastingNotes) ||
    !blank(v.tastingDate) ||
    !blank(v.tastingContext);

  let tasting: ParsedRow["tasting"] = null;
  if (hasTasting) {
    if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
      invalid(COLUMNS.tastingRating, "Rating must be a whole number from 1 to 5");
    }
    let tastedOn: string | null = null;
    if (!blank(v.tastingDate)) {
      const d = text(v.tastingDate);
      if (!isIsoDate(d)) invalid(COLUMNS.tastingDate, "Date must be YYYY-MM-DD");
      else tastedOn = d;
    }
    if (quantity > 1) {
      warn(COLUMNS.tastingRating, "Recorded once against the wine, not once per bottle");
    }
    tasting = {
      rating,
      notes: blank(v.tastingNotes) ? null : text(v.tastingNotes),
      tastedOn,
      context: blank(v.tastingContext) ? null : text(v.tastingContext),
    };
  }

  // ── Storage: resolved later against the cellar's own locations ──
  const storageLocation = blank(v.storageLocation) ? null : text(v.storageLocation);
  const position = blank(v.position) ? null : text(v.position);
  if (position && !storageLocation) {
    warn(
      COLUMNS.position,
      "A position needs a storage location — this bottle will be unpositioned",
    );
  }
  if (position && quantity > 1) {
    warn(
      COLUMNS.position,
      `One position for ${quantity} bottles — the first takes it, the rest are unpositioned`,
    );
  }

  const severity: Severity = issues.some((i) => i.severity === "invalid")
    ? "invalid"
    : issues.length > 0
      ? "warning"
      : "valid";

  return {
    lineNumber,
    raw,
    severity,
    issues,
    producer,
    wineName,
    wineType: isRejected(typeResult) ? null : typeResult.value,
    vintage,
    country: blank(v.country) ? null : text(v.country),
    region: blank(v.region) ? null : text(v.region),
    appellation: blank(v.appellation) ? null : text(v.appellation),
    // Semicolons, because commas fight the file format.
    grapes: blank(v.grapes)
      ? []
      : text(v.grapes)
          .split(/[;|]/)
          .map((g) => g.trim())
          .filter(Boolean),
    drinkFrom,
    drinkUntil,
    notes: blank(v.notes) ? null : text(v.notes),
    bottleSize: isRejected(sizeResult) ? "750ml" : sizeResult.value,
    quantity,
    status,
    purchasePrice,
    purchaseCurrency,
    purchaseDate,
    purchaseSource: blank(v.purchaseSource) ? null : text(v.purchaseSource),
    valuation,
    tasting,
    storageLocation,
    position,
  };
}
